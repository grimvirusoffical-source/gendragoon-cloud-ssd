package app.gendragoon.cloudssd.mobile;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.concurrent.ExecutionException;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public final class CloudSignalsTest {
    @Test public void chunkPut423RoutesToLockScreenWithoutToast(){
        String body="{\"error\":\"workspace_lock\",\"workspaces\":[{\"id\":\"11111111-1111-1111-1111-111111111111\",\"name\":\"Photos\",\"issue\":\"over_cap\"},{\"id\":\"22222222-2222-2222-2222-222222222222\",\"name\":\"Archive\",\"reason\":\"unpaid\"}]}";
        CloudSignals.Route route=CloudSignals.route(423,body,"PUT");
        assertEquals(CloudSignals.Destination.LOCK_SCREEN,route.destination);
        assertEquals("PUT",route.method);
        assertNull(route.toast);
        assertEquals("Photos",route.lock.workspaces.get(0).name);
        assertEquals("over_cap",route.lock.workspaces.get(0).issue);
        assertEquals("Photos · over the plan cap",route.lock.workspaces.get(0).label());
        assertEquals("unpaid",route.lock.workspaces.get(1).issue);
        assertEquals("Some workspaces are over the plan cap or unpaid.",route.lock.issueSummary());

        WorkspaceLocked locked=new WorkspaceLocked(route.lock);
        CloudSignals.FailureNotice notice=CloudSignals.transferFailure(new ExecutionException(locked),false);
        CloudSignals.Presentation shown=CloudSignals.present(notice);
        assertEquals(CloudSignals.ROUTE_LOCK,notice.route);
        assertNull(notice.message);
        assertTrue(notice.lockJson.contains("Photos"));
        assertTrue(shown.lockScreen);
        assertNull(shown.toast);
        assertFalse(CloudSignals.shouldToast(locked));
        assertFalse(CloudSignals.allowsTransfer("PUT",true));
        assertTrue(CloudSignals.allowsTransfer("GET",true));
        assertTrue(CloudSignals.allowsTransfer("HEAD",true));
    }

    @Test public void successAndGenericErrors(){
        CloudSignals.Route ok=CloudSignals.route(200,"{\"ok\":true}","GET");
        assertEquals(CloudSignals.Destination.CONTINUE,ok.destination);
        assertNull(ok.toast);
        CloudSignals.Route failed=CloudSignals.route(500,"{\"error\":\"unavailable\"}","PUT");
        assertEquals(CloudSignals.Destination.GENERIC_ERROR,failed.destination);
        assertEquals("unavailable",failed.toast);
        CloudSignals.Presentation shown=CloudSignals.present(CloudSignals.transferFailure(new Exception("unavailable"),false));
        assertFalse(shown.lockScreen);
        assertEquals("unavailable",shown.toast);
        assertTrue(CloudSignals.allowsTransfer("PUT",false));
    }

    @Test public void freshSignInWindowIsFiveMinutes(){
        String payload="{\"auth_time\":1700000000}";
        String encoded=Base64.getUrlEncoder().withoutPadding().encodeToString(payload.getBytes(StandardCharsets.UTF_8));
        String jwt="eyJhbGciOiJub25lIn0."+encoded+".";
        long auth=1700000000L*1000L;
        assertEquals(Long.valueOf(auth),CloudSignals.authTimeMillis(jwt));
        assertTrue(CloudSignals.freshSignIn(jwt,auth+CloudSignals.FRESH_SIGN_IN_MS));
        assertFalse(CloudSignals.freshSignIn(jwt,auth+CloudSignals.FRESH_SIGN_IN_MS+1));
        assertFalse(CloudSignals.freshSignIn("not-a-jwt",auth));
    }
}
