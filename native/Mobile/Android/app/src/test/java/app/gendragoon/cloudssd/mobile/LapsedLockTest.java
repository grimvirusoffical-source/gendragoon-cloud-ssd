package app.gendragoon.cloudssd.mobile;

import static org.junit.Assert.*;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.Test;

/** Avery's review on e5f1982: a lapsed lock is per workspace and is never a dead end. */
public class LapsedLockTest {
    private static final String LAPSED_ID="11111111-1111-4111-8111-000000000022";
    private static final String OPEN_ID="11111111-1111-4111-8111-000000000024";

    private static WorkspaceLock lapsed(){
        return WorkspaceLock.decode(BackendFixtures.responseBody("workspace-lock","byo-lapsed"));
    }
    private static List<WorkspaceLock.Item> known(){
        return List.of(new WorkspaceLock.Item("free",WorkspaceNames.freeName("Ignored",true),null),
                new WorkspaceLock.Item(LAPSED_ID,"Lapsed BYO",null),
                new WorkspaceLock.Item(OPEN_ID,"Open BYO",null));
    }

    @Test public void lapsedLockHasItsOwnTextWithoutPlanLimitOrOverByZero(){
        WorkspaceLock lock=lapsed();
        assertTrue(lock.isLapsed());
        assertEquals(0,lock.overBy);
        assertEquals("",lock.overByText());
        assertEquals(WorkspaceLock.LAPSED_TITLE,lock.title());
        assertEquals(WorkspaceLock.LAPSED_BODY,lock.bodyText());
        assertFalse(lock.bodyText().contains("plan limit"));
        assertFalse(lock.bodyText().contains("Over by"));
        WorkspaceLock cap=WorkspaceLock.decode(BackendFixtures.responseBody("workspace-lock","over-cap"));
        assertFalse(cap.isLapsed());
        assertEquals(WorkspaceLock.LIMIT_BODY,cap.bodyText());
    }

    @Test public void lapsedWorkspaceCanStillPayWithItsCheckoutUrl(){
        assertEquals("https://billing.example.test/checkout/22",WorkspacePolicy.checkoutUrl(" https://billing.example.test/checkout/22 "));
        assertNull("no URL hides Pay",WorkspacePolicy.checkoutUrl(null));
        assertNull(WorkspacePolicy.checkoutUrl(""));
        assertNull(WorkspacePolicy.checkoutUrl("http://billing.example.test/checkout"));
        assertNull(WorkspacePolicy.checkoutUrl("javascript:alert(1)"));
        assertEquals(List.of(LAPSED_ID),lapsed().unpaidIds);
    }

    @Test public void lapsedWorkspaceCanSwitchToFreeOrAnotherWorkspace(){
        List<WorkspaceLock.Item> targets=lapsed().switchTargets(known());
        assertEquals(2,targets.size());
        assertEquals("free",targets.get(0).id);
        assertEquals("Free",targets.get(0).name);
        assertEquals(OPEN_ID,targets.get(1).id);
        for(WorkspaceLock.Item item:targets)assertNotEquals(LAPSED_ID,item.id);
    }

    @Test public void switchingResetsTheSavedSelectionAndClearsTheLock(){
        Map<String,String> prefs=new HashMap<>();
        prefs.put(WorkspaceNames.selectionKey("uid-1"),LAPSED_ID);
        String opened=WorkspaceNames.switchTo(prefs::put,"uid-1",OPEN_ID);
        assertEquals(OPEN_ID,opened);
        assertEquals("next launch opens the new workspace, not the lapsed one",OPEN_ID,prefs.get(WorkspaceNames.selectionKey("uid-1")));
        WorkspaceLock lock=lapsed();
        assertTrue(lock.appliesTo(LAPSED_ID));
        assertFalse("the lapsed lock does not follow the user to another workspace",lock.appliesTo(opened));
        assertFalse(lock.appliesTo("free"));
        assertEquals("free",WorkspaceNames.switchTo(prefs::put,"uid-1",null));
        // Over-cap locks stay account-wide.
        assertTrue(WorkspaceLock.decode(BackendFixtures.responseBody("workspace-lock","over-cap")).appliesTo(OPEN_ID));
    }

    @Test public void freeNameComesFromIsFree(){
        assertEquals("Free",WorkspaceNames.freeName("Starter",true));
        assertEquals("Starter",WorkspaceNames.freeName("Starter",false));
        assertEquals("Starter",WorkspaceNames.freeName("Starter",null));
        assertEquals("Workspace",WorkspaceNames.freeName(" ",null));
    }

    @Test public void lowLevelSenderRefusesMissingOrBlankTokens(){
        for(String token:new String[]{null,""," ","\t\n"}){
            try{CloudApi.authorization(token);fail("blank token must send nothing");}
            catch(CloudApi.Failure expected){assertEquals(0,expected.status);}
        }
        try{assertEquals("Bearer abc",CloudApi.authorization("abc"));}catch(CloudApi.Failure e){throw new AssertionError(e);}
    }
}
