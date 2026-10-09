"""Render and deploy an explicitly selected MCP release; never change public DNS."""
import argparse
from datetime import datetime, timezone
import json
import hashlib
import os
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.parse import urlparse

import yaml

ROOT = Path(__file__).resolve().parents[2]
REPO = 'https://github.com/synchronicity-labs/mcp-server.git'
IMAGE = '428519446578.dkr.ecr.us-east-1.amazonaws.com/sync-product/mcp-server'
CLUSTERS = {'dev': 'sync-eks-dev-blue', 'production': 'sync-eks-prod'}
CHECKS = ('chatgpt', 'refresh', 'uploads', 'isolation', 'scale', 'rollout', 'pod_loss',
          'no_paid_replay', 'resources', 'memory')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def run(*args):
    return subprocess.check_output(args, text=True, cwd=ROOT).strip()


def sha(value):
    require(bool(re.fullmatch('[0-9a-f]{40}', value)), 'Use a full lowercase commit SHA')
    return value


def https_url(value):
    url = urlparse(value)
    require(url.scheme == 'https' and url.hostname and not url.username and not url.password,
            'An HTTPS evidence URL without credentials is required')
    return value


def delivery_fingerprint():
    files = sorted((ROOT / 'infra/k8s').rglob('*.yaml')) + [
        ROOT / 'scripts/eks/release.py', ROOT / 'scripts/eks/requirements.txt',
        ROOT / '.github/workflows/eks-image.yml', ROOT / '.github/workflows/eks-deploy.yml',
    ]
    digest = hashlib.sha256()
    for path in files:
        digest.update(str(path.relative_to(ROOT)).encode() + b'\0' + path.read_bytes() + b'\0')
    return digest.hexdigest()


def validate_acceptance(record, source, digest, mode):
    require(record['delivery_sha256'] == delivery_fingerprint(),
            'Delivery configuration changed since dev acceptance')
    require(record['source_sha'] == source and record['image_digest'] == digest,
            'Acceptance must cover the selected image and source')
    require(record['routing'] == mode, 'Acceptance must cover the selected routing mode')
    require(all(record['checks'].get(k) == 'passed' for k in CHECKS),
            'All real-client acceptance checks must pass')
    start = datetime.fromisoformat(record['soak_started_at'].replace('Z', '+00:00'))
    end = datetime.fromisoformat(record['soak_finished_at'].replace('Z', '+00:00'))
    require(start.tzinfo and end.tzinfo, 'Soak timestamps must include timezone')
    require((end - start).total_seconds() >= 86400 and end <= datetime.now(timezone.utc),
            'A completed 24-hour dev soak is required')
    require(bool(record['reviewed_by'].strip()), 'Acceptance reviewer is required')
    https_url(record['evidence_url'])


def application(env, source, digest, revision, host, readiness, mode='alb', acceptance=None):
    require(env in CLUSTERS, 'Unknown environment')
    sha(source)
    sha(revision)
    require(bool(re.fullmatch('sha256:[0-9a-f]{64}', digest)), 'Use an immutable SHA256 digest')
    suffix = 'dev' if env == 'dev' else 'prod'
    require(bool(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.' + suffix +
                             r'\.sync-internal\.com', host)), 'Only an approved staging hostname is allowed')
    https_url(readiness)
    require(mode in ('alb', 'owner'), 'Routing must be alb or owner')
    if env == 'production':
        require(acceptance is not None, 'Production staging requires recorded dev acceptance')
        validate_acceptance(acceptance, source, digest, mode)
    env_values = {
        'GIT_SHA': source,
        'MCP_ISSUER_URL': 'https://mcp.sync.so' if env == 'production' else f'https://{host}',
        'SYNC_BASE_URL': 'https://api.sync.so' if env == 'production' else 'https://dev-api.sync.so',
        'MCP_REPLICA_SERVICE': 'mcp-server-peers.sync-mcp.svc.cluster.local' if mode == 'owner' else '',
        'MCP_REPLICA_PORT': '3002',
    }
    deployment = {'apiVersion': 'apps/v1', 'kind': 'Deployment', 'metadata': {'name': 'sync-mcp'},
                  'spec': {'template': {'spec': {'containers': [{'name': 'mcp', 'env': [
                      {'name': k, 'value': v} for k, v in env_values.items()
                  ] + [{'name': 'MCP_REPLICA_IP', 'valueFrom': {'fieldRef': {'fieldPath': 'status.podIP'}}}]}]}}}}
    annotations = {'external-dns.alpha.kubernetes.io/hostname': host}
    if mode == 'owner':
        annotations['alb.ingress.kubernetes.io/target-group-attributes'] = (
            'deregistration_delay.timeout_seconds=60,stickiness.enabled=false')
    if env == 'production':
        # Only the staging hostname is owned by external-dns. Public origin switch is separate.
        annotations['alb.ingress.kubernetes.io/conditions.sync-mcp'] = json.dumps([
            {'field': 'host-header', 'hostHeaderConfig': {'values': ['mcp.sync.so']}}])
    ingress = {'apiVersion': 'networking.k8s.io/v1', 'kind': 'Ingress',
               'metadata': {'name': 'sync-mcp', 'annotations': annotations},
               'spec': {'tls': [{'hosts': [host]}], 'rules': [{'host': host, 'http': {'paths': [
                   {'path': '/', 'pathType': 'Prefix', 'backend': {
                       'service': {'name': 'sync-mcp', 'port': {'number': 80}}}}]}}]}}
    kustomize = {'images': [f'MCP_IMAGE={IMAGE}@{digest}'],
                'patches': [{'patch': yaml.safe_dump(x, sort_keys=False)} for x in [deployment, ingress]]}
    path = f'infra/k8s/overlays/{env}' + ('-owner' if mode == 'owner' else '')
    return {'apiVersion': 'argoproj.io/v1alpha1', 'kind': 'Application',
            'metadata': {'name': f'sync-mcp-{env}', 'namespace': 'argocd',
                         'annotations': {'sync.so/readiness': readiness, 'sync.so/source-sha': source}},
            'spec': {'project': 'default', 'source': {'repoURL': REPO, 'path': path,
                     'targetRevision': revision, 'kustomize': kustomize},
                     'destination': {'name': CLUSTERS[env], 'namespace': 'sync-mcp'},
                     'syncPolicy': {'syncOptions': ['FailOnSharedResource=true']}}}


def render(app):
    source = app['spec']['source']
    # Render the same Kustomize input Argo will receive, without editing tracked files.
    with tempfile.TemporaryDirectory(dir=ROOT / '.cache') as temp:
        directory = Path(temp)
        customization = {'apiVersion': 'kustomize.config.k8s.io/v1beta1', 'kind': 'Kustomization',
                         'resources': [os.path.relpath(ROOT / source['path'], directory)],
                         **source['kustomize']}
        # Argo's image override shorthand is translated by its Kustomize adapter.
        image = source['kustomize']['images'][0].split('=', 1)[1]
        name, digest = image.split('@', 1)
        customization['images'] = [{'name': 'MCP_IMAGE', 'newName': name, 'digest': digest}]
        (directory / 'kustomization.yaml').write_text(yaml.safe_dump(customization))
        return run('kubectl', 'kustomize', str(directory))


def validate_environment(environment):
    name = 'eks-production' if environment == 'production' else 'eks-dev'
    repository = 'repos/synchronicity-labs/mcp-server'
    settings = json.loads(run('gh', 'api', f'{repository}/environments/{name}'))
    rules = [x for x in settings.get('protection_rules', []) if x['type'] == 'required_reviewers']
    require(any(x.get('reviewers') for x in rules), 'GitHub environment needs required reviewers')
    if environment == 'production':
        require(all(x.get('prevent_self_review') for x in rules), 'Production must prevent self-review')
    policy = settings.get('deployment_branch_policy') or {}
    require(policy.get('custom_branch_policies') and not policy.get('protected_branches'),
            'GitHub environment must explicitly allow only main')
    branches = json.loads(run('gh', 'api', f'{repository}/environments/{name}/deployment-branch-policies'))
    policies = branches.get('branch_policies', [])
    require(len(policies) == 1 and policies[0]['name'] == 'main' and
            policies[0].get('type', 'branch') == 'branch', 'Environment allows a non-main ref')


def validate_image(source, digest):
    response = json.loads(run('aws', 'ecr', 'describe-repositories', '--region', 'us-east-1',
                              '--repository-names', 'sync-product/mcp-server'))
    require(response['repositories'][0]['repositoryUri'] == IMAGE, 'Registry account or repository mismatch')
    require(response['repositories'][0]['imageTagMutability'] == 'IMMUTABLE',
            'ECR repository must have immutable tags without exclusions')
    image = json.loads(run('aws', 'ecr', 'describe-images', '--region', 'us-east-1',
                          '--repository-name', 'sync-product/mcp-server', '--image-ids',
                          f'imageTag=sha-{source}'))
    require(image['imageDetails'][0]['imageDigest'] == digest, 'Digest does not match the source tag')


def deploy(app, output):
    name = app['metadata']['name']
    # A scoped Argo token must permit list/read/create/update/sync only for these MCP apps.
    existing = json.loads(run('argocd', 'app', 'list', '-o', 'json'))
    previous = next((x for x in existing if x['metadata']['name'] == name), None)
    if previous:
        spec = previous['spec']
        require(spec['destination'] == app['spec']['destination'] and
                spec.get('source', {}).get('repoURL') == REPO and not spec.get('sources') and
                spec['project'] == 'default' and
                'automated' not in spec.get('syncPolicy', {}),
                'Existing Argo app has unexpected ownership or automated sync')
        (output / 'previous-application.json').write_text(json.dumps(previous, indent=2))
    filename = output / 'application.yaml'
    run('argocd', 'app', 'create', '--file', str(filename), '--upsert')
    run('argocd', 'app', 'sync', name, '--revision', app['spec']['source']['targetRevision'], '--timeout', '600')
    run('argocd', 'app', 'wait', name, '--health', '--sync', '--operation', '--timeout', '600')
    current = json.loads(run('argocd', 'app', 'get', name, '--refresh', '-o', 'json'))
    require(current['status']['sync']['revision'] == app['spec']['source']['targetRevision'],
            'Argo revision changed during deployment')
    require(current['spec']['source'] == app['spec']['source'], 'Argo source changed during deployment')
    expected_image = app['spec']['source']['kustomize']['images'][0].split('=', 1)[1]
    require(current['status'].get('summary', {}).get('images') == [expected_image],
            'Argo runtime image summary does not match the selected digest')
    (output / 'release-receipt.json').write_text(json.dumps({
        'application': app, 'completed_at': datetime.now(timezone.utc).isoformat(),
        'delivery_sha256': delivery_fingerprint(), 'status': current['status']}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['render', 'deploy'])
    parser.add_argument('--environment', required=True, choices=CLUSTERS)
    parser.add_argument('--source', required=True)
    parser.add_argument('--digest', required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--host', required=True)
    parser.add_argument('--readiness', required=True)
    parser.add_argument('--routing', choices=['alb', 'owner'], default='alb')
    parser.add_argument('--acceptance', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    acceptance = json.loads(args.acceptance.read_text()) if args.acceptance else None
    app = application(args.environment, args.source, args.digest, args.revision, args.host,
                      args.readiness, args.routing, acceptance)
    if args.action == 'deploy':
        require(os.environ.get('GITHUB_REF') == 'refs/heads/main', 'Deploy only from the main workflow')
        require(os.environ.get('GITHUB_REPOSITORY') == 'synchronicity-labs/mcp-server', 'Wrong repository')
        require(run('git', 'rev-parse', 'HEAD') == args.revision, 'Checkout must match manifest revision')
        for commit in [args.source, args.revision]:
            run('git', 'merge-base', '--is-ancestor', commit, 'origin/main')
        if args.routing == 'owner':
            run('git', 'cat-file', '-e', f'{args.source}:src/replica-routing.ts')
        validate_environment(args.environment)
        validate_image(args.source, args.digest)
    args.output.mkdir(parents=True, exist_ok=True)
    (ROOT / '.cache').mkdir(exist_ok=True)
    (args.output / 'application.yaml').write_text(yaml.safe_dump(app, sort_keys=False))
    (args.output / 'rendered.yaml').write_text(render(app))
    if args.action == 'deploy':
        deploy(app, args.output)
    print(f'{args.action}: {app["metadata"]["name"]}; public DNS unchanged')


if __name__ == '__main__':
    main()
