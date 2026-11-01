package app.gendragoon.cloudssd.mobile;
import org.junit.Test;
import static org.junit.Assert.*;
public final class TeamsRouteTest {
 @Test public void communityAndModerationUseOnlyExactMetadataRoutes(){String id="a".repeat(32);for(String path:new String[]{"/v1/receivers/me/dev-community","/v1/receivers/me/dev-reports","/v1/receivers/me/dev-reports/"+id,"/v1/receivers/teams/"+id+"/blocks/"+id,"/v1/receivers/teams/"+id+"/reports/"+id})assertTrue(path,TeamsActivity.allowed(path,"GET"));}
 @Test public void safetyControlsDoNotAddFileKeyBillingOrAdminAuthority(){String id="b".repeat(32);for(String path:new String[]{"/v1/receivers/admin/machine-notes","/v1/integrations/keys","/v2/account/deletion","/v1/receivers/me/workspaces/"+id+"/blobs/"+id,"/v1/receivers/me/library","/v1/receivers/me/dev-reports/"+id+"/file","/v1/receivers/me/dev-community%2ffile","/v1/receivers/me/dev-community\n","https://other.invalid/v1/receivers/me/dev-community"})assertFalse(path,TeamsActivity.allowed(path,"GET"));assertFalse(TeamsActivity.allowed("/v1/receivers/me/dev-community","CONNECT"));}
}
