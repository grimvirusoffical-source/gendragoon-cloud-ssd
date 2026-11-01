import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import quick_login_browser as browser
import quick_login_store as store
import redx_session

class QuickLoginStoreTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform=="win32","Actual Windows DPAPI test")
    def test_windows_dpapi_roundtrip_and_clear(self):
        with tempfile.TemporaryDirectory() as td, patch.dict(os.environ,{"LOCALAPPDATA":td}):
            token="rxcr_"+"A"*43
            self.assertTrue(store.save(token,"account-fixture","fixture@example.invalid","20days",1893456000000))
            self.assertNotIn(token,(Path(td)/"Red-XAI"/"QuickLogin"/"gendragoon.dpapi").read_bytes().decode("latin1","ignore"))
            saved=store.load()
            self.assertEqual(saved["refresh"],token)
            self.assertEqual(saved["subject"],"account-fixture")
            store.clear()
            self.assertIsNone(store.load())

    def test_browser_validation_accepts_only_quick_login_fragment(self):
        good="https://red-xai.com/redxai-connectx#request=opaque"
        self.assertEqual(browser.validate(good),good)
        for value in ("http://red-xai.com/redxai-connectx#request=x",
                      "https://evil.invalid/redxai-connectx#request=x",
                      "https://red-xai.com/redxai-connectx?request=x",
                      "https://red-xai.com/redxai-connectx#wrong=x"):
            with self.subTest(value=value),self.assertRaises(browser.BrowserLaunchError):
                browser.validate(value)

class SessionResumeTests(unittest.TestCase):
    def test_saved_refresh_resumes_same_subject_and_rotates_secret(self):
        session=redx_session.RedXSession()
        calls=[]
        response={
            "access_token":"rxca_"+"a"*43,
            "refresh_token":"rxcr_"+"b"*43,
            "expires_in":3600,
            "remember_device":True,
            "trust_mode":"20days",
            "trusted_until_ms":1893456000000,
            "user":{"sub":"fixture-account","email":"fixture@example.invalid","email_verified":True},
        }
        receiver=redx_session.receiver_id("fixture-account")
        with patch.object(redx_session.quick_login_store,"load",return_value={
                "schema":1,"subject":"fixture-account","email":"fixture@example.invalid",
                "trustMode":"20days","trustedUntilMs":1893456000000,"refresh":"rxcr_"+"c"*43}), \
             patch.object(redx_session.quick_login_store,"save") as save, \
             patch.object(redx_session,"http_json") as http:
            def request(origin,path,method="GET",value=None,token=None,transport=None):
                calls.append((origin,path,method))
                if path=="/redxai-connect/refresh":return response
                if path=="/v1/receivers/me":return {"id":receiver,"state":"ready"}
                raise AssertionError(path)
            http.side_effect=request
            result=session.resume_saved()
        self.assertEqual(result["id"],receiver)
        self.assertEqual(session.subject,"fixture-account")
        self.assertTrue(session.trusted_session)
        save.assert_called_once()
        self.assertEqual(calls[0][1],"/redxai-connect/refresh")

    def test_revoked_saved_refresh_is_removed_and_browser_can_continue(self):
        session=redx_session.RedXSession()
        with patch.object(redx_session.quick_login_store,"load",return_value={
                "subject":"fixture-account","refresh":"rxcr_"+"c"*43}), \
             patch.object(redx_session.quick_login_store,"clear") as clear, \
             patch.object(redx_session,"http_json",side_effect=redx_session.SessionError("revoked",401)):
            self.assertIsNone(session.resume_saved())
        clear.assert_called_once()

if __name__=="__main__":unittest.main()
