"""Read-only Platform handoff checks. Never reads secret values or creates resources."""
import argparse
import json
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--kubeconfig', required=True)
    parser.add_argument('--environment', choices=['dev', 'production'], default='dev')
    args = parser.parse_args()
    cluster = 'sync-eks-dev-blue' if args.environment == 'dev' else 'sync-eks-prod'
    kube = ['kubectl', '--kubeconfig', args.kubeconfig, '--context', cluster, '--request-timeout=15s']
    checks = {
        'namespace': kube + ['get', 'namespace', 'sync-mcp', '-o', 'name'],
        'secret_present': kube + ['get', 'secret', 'sync-mcp-runtime', '-n', 'sync-mcp', '-o', 'name'],
        'nodes_visible': kube + ['get', 'nodes', '-o', 'name'],
        'registry': ['aws', 'ecr', 'describe-repositories', '--region', 'us-east-1',
                     '--repository-names', 'sync-product/mcp-server', '--query',
                     'repositories[].{uri:repositoryUri,immutability:imageTagMutability}'],
    }
    failed = False
    for name, command in checks.items():
        try:
            result = subprocess.run(command, text=True, capture_output=True, timeout=30)
            ok = result.returncode == 0
            detail = (result.stdout if ok else result.stderr).strip()
        except subprocess.TimeoutExpired:
            ok, detail = False, 'Read-only check timed out'
        failed |= not ok
        print(json.dumps({'check': name, 'ok': ok, 'detail': detail}), flush=True)
    raise SystemExit(int(failed))


if __name__ == '__main__':
    main()
