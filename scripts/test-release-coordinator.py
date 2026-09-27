#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
ROOT = Path(__file__).resolve().parents[1]

def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module

release = load('release')
manifest = load('release-manifest')

class ReleaseTests(unittest.TestCase):
    def test_mismatched_manifest_never_accepted(self):
        value = manifest.manifest('v0.4.0', 'sha256:' + 'a' * 64, ROOT)
        release.validate_manifest(value, 'v0.4.0', value['desktop_version'], value['source_commit'])
        for field in ['core_version', 'cli_version', 'desktop_version', 'source_commit', 'api_protocol', 'runtime_protocol', 'backend_image']:
            invalid = {**value, field: 'wrong'}
            with self.assertRaises(RuntimeError):
                release.validate_manifest(invalid, 'v0.4.0', value['desktop_version'], value['source_commit'])

    def test_tags_checked_before_any_mutation(self):
        with patch.object(release, 'git', side_effect=['', 'desktop-v0.1.2', 'old-sha']), patch.object(release, 'run') as run:
            with self.assertRaises(RuntimeError): release.ensure_tags(['v0.4.0', 'desktop-v0.1.2'], 'new-sha')
            run.assert_not_called()

    def test_both_tags_pushed_atomically(self):
        with patch.object(release, 'git', return_value=''), patch.object(release, 'run') as run:
            release.ensure_tags(['v0.4.0', 'desktop-v0.1.2'], 'new-sha')
            self.assertEqual(run.call_args.args[0], ['git', 'push', '--atomic', 'origin', 'refs/tags/v0.4.0', 'refs/tags/desktop-v0.1.2'])

    def test_manifest_requires_digest(self):
        with self.assertRaises(ValueError): manifest.manifest('v0.4.0', 'latest', ROOT)

if __name__ == '__main__': unittest.main()
