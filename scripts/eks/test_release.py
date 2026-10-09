from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import yaml
import release

SOURCE = 'a' * 40
REVISION = 'b' * 40
DIGEST = 'sha256:' + 'c' * 64


def acceptance():
    end = datetime.now(timezone.utc) - timedelta(minutes=1)
    return {'source_sha': SOURCE, 'image_digest': DIGEST, 'routing': 'alb',
            'delivery_sha256': release.delivery_fingerprint(),
            'checks': dict.fromkeys(release.CHECKS, 'passed'),
            'soak_started_at': (end - timedelta(hours=24)).isoformat(),
            'soak_finished_at': end.isoformat(), 'reviewed_by': 'fixture reviewer',
            'evidence_url': 'https://example.com/acceptance'}


def app(env='dev', **kwargs):
    return release.application(env, SOURCE, DIGEST, REVISION,
                               f'mcp.{"dev" if env == "dev" else "prod"}.sync-internal.com',
                               'https://example.com/readiness', **kwargs)


class ReleaseTests(unittest.TestCase):
    def test_actual_kustomize_renders_each_environment_and_mode(self):
        (release.ROOT / '.cache').mkdir(exist_ok=True)
        for env in ['dev', 'production']:
            for mode in ['alb', 'owner']:
                with self.subTest(env=env, mode=mode):
                    record = acceptance()
                    record['routing'] = mode
                    application = app(env, mode=mode, acceptance=record)
                    docs = list(yaml.safe_load_all(release.render(application)))
                    deployment = next(x for x in docs if x['kind'] == 'Deployment')
                    pod = deployment['spec']['template']['spec']
                    container = pod['containers'][0]
                    variables = {x['name']: x.get('value') for x in container['env']}
                    self.assertEqual(container['image'], release.IMAGE + '@' + DIGEST)
                    self.assertEqual(deployment['spec']['replicas'], 3)
                    self.assertEqual(pod['topologySpreadConstraints'][0]['minDomains'], 3)
                    pdb = next(x for x in docs if x['kind'] == 'PodDisruptionBudget')
                    self.assertEqual(pdb['spec']['minAvailable'], 2)
                    self.assertEqual(deployment['spec']['strategy']['rollingUpdate']['maxUnavailable'], 0)
                    self.assertEqual(variables['GIT_SHA'], SOURCE)
                    self.assertEqual(variables['SYNC_BASE_URL'], 'https://api.sync.so' if env == 'production' else 'https://dev-api.sync.so')
                    self.assertEqual(bool(variables['MCP_REPLICA_SERVICE']), mode == 'owner')
                    self.assertTrue(all(x['metadata']['namespace'] == 'sync-mcp' for x in docs))
                    self.assertFalse(any(x['kind'] == 'Namespace' for x in docs))
                    ingress = next(x for x in docs if x['kind'] == 'Ingress')
                    annotations = ingress['metadata']['annotations']
                    self.assertNotIn('mcp.sync.so', annotations['external-dns.alpha.kubernetes.io/hostname'])
                    self.assertIn('stickiness.enabled=' + ('true' if mode == 'alb' else 'false'), annotations['alb.ingress.kubernetes.io/target-group-attributes'])
                    peers = [x for x in docs if x['metadata']['name'] == 'mcp-server-peers']
                    self.assertEqual(len(peers), int(mode == 'owner'))
                    if peers:
                        self.assertEqual(peers[0]['spec']['clusterIP'], 'None')
                    self.assertNotIn('automated', application['spec']['syncPolicy'])

    def test_prod_refuses_missing_or_stale_acceptance(self):
        with self.assertRaises(ValueError):
            app('production')
        for field, value in [('source_sha', 'd' * 40), ('image_digest', 'sha256:' + 'e' * 64),
                             ('routing', 'owner'), ('reviewed_by', ''),
                             ('delivery_sha256', '0' * 64),
                             ('soak_started_at', datetime.now(timezone.utc).isoformat())]:
            with self.subTest(field=field):
                record = acceptance()
                record[field] = value
                with self.assertRaises(ValueError):
                    app('production', acceptance=record)
        for check in release.CHECKS:
            record = acceptance()
            record['checks'][check] = 'pending'
            with self.assertRaises(ValueError):
                app('production', acceptance=record)

    def test_refuses_public_host_wrong_environment_and_mutable_image(self):
        for host in ['mcp.sync.so', 'mcp.prod.sync-internal.com', 'bad.dev.sync-internal.com.evil.test']:
            with self.assertRaises(ValueError):
                release.application('dev', SOURCE, DIGEST, REVISION, host, 'https://example.com')
        with self.assertRaises(ValueError):
            release.application('dev', SOURCE, 'latest', REVISION, 'mcp.dev.sync-internal.com', 'https://example.com')

    def test_registry_requires_matching_digest_and_immutability(self):
        repository = json.dumps({'repositories': [{'imageTagMutability': 'IMMUTABLE'}]})
        image = json.dumps({'imageDetails': [{'imageDigest': DIGEST}]})
        with patch('release.run', side_effect=[repository, image]):
            release.validate_image(SOURCE, DIGEST)
        with patch('release.run', return_value=repository.replace('IMMUTABLE', 'MUTABLE')):
            with self.assertRaises(ValueError):
                release.validate_image(SOURCE, DIGEST)
        with patch('release.run', side_effect=[repository, image.replace(DIGEST, 'other')]):
            with self.assertRaises(ValueError):
                release.validate_image(SOURCE, DIGEST)

    def test_deploy_refuses_existing_app_owned_by_other_repository(self):
        existing = deepcopy(app())
        existing['spec']['source']['repoURL'] = 'https://example.com/other.git'
        with tempfile.TemporaryDirectory() as temp, patch('release.run', return_value=json.dumps([existing])) as command:
            with self.assertRaises(ValueError):
                release.deploy(app(), Path(temp))
            self.assertEqual(command.call_count, 1)

class EnvironmentTests(unittest.TestCase):
    def test_requires_reviewers_main_only_and_production_self_review_protection(self):
        settings = {'protection_rules': [{'type': 'required_reviewers', 'reviewers': [{'id': 1}],
                                         'prevent_self_review': True}],
                    'deployment_branch_policy': {'custom_branch_policies': True, 'protected_branches': False}}
        branches = {'branch_policies': [{'name': 'main', 'type': 'branch'}]}
        with patch('release.run', side_effect=[json.dumps(settings), json.dumps(branches)]):
            release.validate_environment('production')
        for changed in [{}, {**settings, 'protection_rules': []},
                        {**settings, 'protection_rules': [{'type': 'required_reviewers', 'reviewers': [{'id': 1}]}]}]:
            with patch('release.run', return_value=json.dumps(changed)):
                with self.assertRaises(ValueError):
                    release.validate_environment('production')
        branches['branch_policies'].append({'name': '*', 'type': 'tag'})
        with patch('release.run', side_effect=[json.dumps(settings), json.dumps(branches)]):
            with self.assertRaises(ValueError):
                release.validate_environment('dev')


if __name__ == '__main__':
    unittest.main()
