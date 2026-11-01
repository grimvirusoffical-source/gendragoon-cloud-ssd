"""Desktop Teams metadata/UGC routes cannot become a file or billing proxy."""
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import machinenotes_client as client

class TeamRouteTests(unittest.TestCase):
    def test_current_community_reports_and_moderation_metadata_are_supported(self):
        target="a"*32
        accepted=["/v1/receivers/me/dev-"+name for name in ("profile","teams","community")]
        accepted += ["/v1/receivers/me/dev-reports","/v1/receivers/me/dev-reports/"+target,
            "/v1/receivers/me/workspaces/"+target+"/team","/v1/receivers/teams/join"]
        accepted += ["/v1/receivers/teams/"+target+"/"+resource+suffix for resource in
            ("members","invites","messages","presence","signals","membership","blocks","reports") for suffix in ("","/"+target)]
        for route in accepted:
            with self.subTest(route=route):
                self.assertTrue(client.team_route_allowed(route))
                self.assertTrue(client.team_route_allowed(route+"?limit=50&cursor=abc_DEF-1"))

    def test_storage_keys_billing_cross_origin_and_unbounded_queries_are_rejected(self):
        target="a"*32
        denied=["/v1/receivers/me/blobs","/v1/receivers/me/dev-delete-account","/v1/receivers/me/dev-reports/../../blobs",
            "/v1/receivers/me/workspaces/"+target+"/library","/v1/receivers/me/workspaces/"+target+"/team/blobs",
            "/v1/receivers/teams/"+target+"/keys","/v1/integrations/keys","/v2/billing/portal",
            "https://other.invalid/v1/receivers/me/dev-profile","//other.invalid/v1/receivers/me/dev-profile",
            "/v1/receivers/me/dev-profile#ignored","/v1/receivers/me/dev-\nprofile","/v1/receivers/me/dev-reports/"+"A"*32]
        denied += ["/v1/receivers/me/dev-teams"+suffix for suffix in ("?","?limit=0","?limit=51","?limit=050","?limit=50&limit=1","?cursor=", "?cursor="+"A"*301,"?limit=50&admin=true","?cursor=x&cursor=y")]
        for route in denied:
            with self.subTest(route=repr(route)):self.assertFalse(client.team_route_allowed(route))

    def test_model_checks_exact_routes_before_forwarding_or_authority_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            request=MagicMock(return_value={"accepted":True})
            session=SimpleNamespace(integration_mode=False,request=request)
            model=client.MachineNotesClient(session,Path(temporary)/"profile")
            self.assertEqual(model.team_request("/v1/receivers/me/dev-reports","POST",{"kind":"report"}),{"accepted":True})
            self.assertEqual(request.call_count,1)
            for path,method in (("/v1/receivers/me/blobs","DELETE"),("/v1/receivers/me/dev-profile","CONNECT")):
                with self.assertRaises(ValueError):model.team_request(path,method)
            session.integration_mode=True
            with self.assertRaises(client.SessionError):model.team_request("/v1/receivers/me/dev-community")
            self.assertEqual(request.call_count,1)

if __name__=="__main__":unittest.main()
