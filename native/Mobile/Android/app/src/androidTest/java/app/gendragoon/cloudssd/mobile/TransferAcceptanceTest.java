package app.gendragoon.cloudssd.mobile;

import android.app.ActivityManager;
import android.content.*;
import android.database.Cursor;
import android.net.Uri;
import android.os.Process;
import android.provider.DocumentsContract;
import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.work.*;
import org.json.JSONObject;
import org.junit.*;
import org.junit.runner.RunWith;
import java.io.*;
import java.nio.file.Files;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import java.util.zip.ZipFile;
import static org.junit.Assert.*;

/** Real framework, provider and Worker tests in a disposable debug identity. No live account. */
@RunWith(AndroidJUnit4.class)
public final class TransferAcceptanceTest {
    private static final String TAG="GenDragoon-owned-transfer-acceptance";
    private Context context;private String owner;private WorkManager manager;
    private TransferAcceptanceApplication application;
    private ActivityScenario<TransferAcceptanceActivity> scenario;
    private final List<UUID> owned=new ArrayList<>();
    private interface Check {boolean done()throws Exception;}
    private static void await(String message,Check check,long seconds)throws Exception{
        long deadline=android.os.SystemClock.elapsedRealtime()+seconds*1000;
        while(android.os.SystemClock.elapsedRealtime()<deadline){if(check.done())return;Thread.sleep(40);}
        fail(message);
    }
    @Before public void setup()throws Exception{
        context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        owner=InstrumentationRegistry.getInstrumentation().getContext().getPackageName();
        assertTrue("Acceptance must use an isolated debug application ID",context.getPackageName().endsWith(".debug"));
        application=(TransferAcceptanceApplication)context.getApplicationContext();manager=WorkManager.getInstance(context);
        for(WorkInfo work:manager.getWorkInfosByTag(TAG).get(10,TimeUnit.SECONDS))assertTrue("Prior owned work is still active",work.getState().isFinished());
        assertFalse(TransferLease.active());application.backend.reset();scenario=ActivityScenario.launch(TransferAcceptanceActivity.class);
    }
    @After public void finishOwnedActivityOnly()throws Exception{
        if(application!=null){TransferAcceptanceApplication.Hold hold=application.backend.nextHold.getAndSet(null);if(hold!=null)hold.close();}
        if(manager!=null)await("Owned Worker body did not finish; private fixtures retained",()->{
            for(UUID id:owned){WorkInfo info=manager.getWorkInfoById(id).get(10,TimeUnit.SECONDS);if(info==null||!info.getState().isFinished())return false;}
            return !TransferLease.active();
        },75);
        if(scenario!=null)scenario.close();
        // No recursive fixture deletion: failed jobs remain attributable until their real body exits.
    }
    private Uri fixture(String mode)throws Exception{
        AtomicReference<Uri> prior=new AtomicReference<>();scenario.onActivity(activity->{prior.set(activity.selected);activity.requestFixture(owner,mode);});
        AtomicReference<Uri> result=new AtomicReference<>();
        await("Cross-UID fixture grant did not complete: "+mode,()->{scenario.onActivity(activity->{if(activity.selected!=null&&!activity.selected.equals(prior.get()))result.set(activity.selected);});return result.get()!=null;},15);
        return result.get();
    }
    private static byte[] bytes(Context context,Uri uri)throws Exception{
        try(InputStream input=context.getContentResolver().openInputStream(uri);ByteArrayOutputStream output=new ByteArrayOutputStream()){
            assertNotNull(input);byte[] buffer=new byte[65536];int count;while((count=input.read(buffer))!=-1){if(output.size()+count>1024*1024)throw new IOException("Owned fixture exceeds bound");output.write(buffer,0,count);}return output.toByteArray();
        }
    }
    private Data uploadData(Uri uri,boolean folder){return new Data.Builder().putString("subject",TransferAcceptanceApplication.SUBJECT).putString("workspace",TransferAcceptanceApplication.WORKSPACE).putString("action","upload").putString("uri",uri.toString()).putBoolean("folder",folder).build();}
    private OneTimeWorkRequest request(Data data){OneTimeWorkRequest request=new OneTimeWorkRequest.Builder(TransferWorker.class).setInputData(data).addTag(TAG).build();owned.add(request.getId());return request;}
    private UUID start(Data data)throws Exception{OneTimeWorkRequest work=request(data);manager.enqueue(work).getResult().get(10,TimeUnit.SECONDS);return work.getId();}
    private WorkInfo finished(UUID id)throws Exception{
        AtomicReference<WorkInfo> result=new AtomicReference<>();await("Owned transfer did not reach a terminal result",()->{WorkInfo info=manager.getWorkInfoById(id).get(10,TimeUnit.SECONDS);if(info!=null&&info.getState().isFinished())result.set(info);return result.get()!=null;},180);return result.get();
    }
    private WorkInfo download(JSONObject item)throws Exception{
        return finished(start(new Data.Builder().putString("subject",TransferAcceptanceApplication.SUBJECT).putString("workspace",TransferAcceptanceApplication.WORKSPACE).putString("action","download").putString("item",item.toString()).build()));
    }
    private File job(UUID id){return new File(context.getFilesDir(),"redx-jobs/"+id);}
    private Uri failedBeforeBackend(String mode)throws Exception{
        Uri source=fixture(mode);int before=application.backend.uploads.get();UUID id=start(uploadData(source,true));WorkInfo result=finished(id);
        assertEquals(mode,WorkInfo.State.FAILED,result.getState());assertEquals(mode,before,application.backend.uploads.get());assertTrue("Failed private job retained",job(id).isDirectory());assertFalse(new File(job(id),"verified.archive").exists());
        assertEquals(RedXSession.receiver(TransferAcceptanceApplication.SUBJECT),new String(Files.readAllBytes(new File(job(id),"account.receiver").toPath()),java.nio.charset.StandardCharsets.US_ASCII));
        return source;
    }
    private int[] diagnostics(Uri source)throws Exception{
        Uri root=DocumentsContract.buildDocumentUriUsingTree(source,DocumentsContract.getTreeDocumentId(source));
        String[] columns={"owner_uid","caller_uid","initial_windows","initial_rows","later_windows","later_position","later_throws","later_stops","advertised_count","changed_count","physical_rows"};
        try(Cursor cursor=context.getContentResolver().query(root,columns,null,null,null)){
            assertNotNull(cursor);assertTrue(cursor.moveToFirst());int[] result=new int[columns.length];for(int n=0;n<result.length;n++)result[n]=cursor.getInt(n);
            assertNotEquals("Provider diagnostics must come from a different UID",Process.myUid(),result[0]);assertEquals(Process.myUid(),result[1]);return result;
        }
    }
    @Test public void incompleteProviderListingsNeverReachBackend()throws Exception{
        for(String mode:new String[]{"query-failure","null","loading","total","duplicate-id","wrong-loading","null-loading","wrong-total","null-total","negative-total","error","negative-count","over-budget"})failedBeforeBackend(mode);
        for(String mode:new String[]{"cursor-failure","cursor-stop"}){
            int[] proof=diagnostics(failedBeforeBackend(mode));
            assertTrue("A real first IPC window was required",proof[2]>=1);assertEquals("First IPC window contains exactly one row",1,proof[3]);
            assertTrue("The app must request a later IPC window after consuming row zero",proof[4]>=1);assertEquals(1,proof[5]);assertEquals(3,proof[8]);assertEquals(3,proof[10]);
            if(mode.equals("cursor-failure")){assertTrue(proof[6]>=1);assertEquals(0,proof[7]);}
            else{assertEquals(0,proof[6]);assertTrue("Actual provider false move makes the framework return a null window",proof[7]>=1);}
        }
        int[] mismatch=diagnostics(failedBeforeBackend("count-mismatch"));assertEquals(4,mismatch[8]);assertEquals(3,mismatch[10]);assertTrue(mismatch[4]>=1);
        int[] changed=diagnostics(failedBeforeBackend("changed-count"));assertEquals(3,changed[8]);assertEquals(2,changed[9]);assertTrue(changed[4]>=1);
    }
    @Test public void unsafeCollidingAndExcessivelyDeepSelectionsAreRetained()throws Exception{
        for(String mode:new String[]{"collision","unicode-collision","bad-name","depth"})failedBeforeBackend(mode);
    }
    @Test public void completeNestedAndEmptyFoldersRoundtripThroughActualWorker()throws Exception{
        for(String mode:new String[]{"folder","empty"}){
            application.backend.reset();Uri uri=fixture(mode);UUID upload=start(uploadData(uri,true));assertEquals(WorkInfo.State.SUCCEEDED,finished(upload).getState());assertFalse("Only verified upload cache may be cleared",job(upload).exists());
            WorkInfo result=download(application.backend.item());assertEquals(WorkInfo.State.SUCCEEDED,result.getState());assertTrue(result.getOutputData().getBoolean("archiveExport",false));
            try(ZipFile archive=new ZipFile(result.getOutputData().getString("path"))){
                assertNotNull(archive.getEntry("Selected folder/"));
                if(mode.equals("folder")){assertNotNull(archive.getEntry("Selected folder/Empty folder/"));assertNotNull(archive.getEntry("Selected folder/Nested/雪-é.bin"));assertEquals(8192,archive.getEntry("Selected folder/binary.bin").getSize());}
                else assertEquals(1,archive.size());
            }
            Uri destination=fixture("output");MainActivity.exportVerifiedArchive(context,result.getOutputData().getString("path"),destination);
            assertArrayEquals(Files.readAllBytes(new File(result.getOutputData().getString("path")).toPath()),bytes(context,destination));
        }
    }
    @SuppressWarnings("deprecation") private boolean foregroundService(){
        ActivityManager manager=(ActivityManager)context.getSystemService(Context.ACTIVITY_SERVICE);
        for(ActivityManager.RunningServiceInfo service:manager.getRunningServices(100))if(service.service.getClassName().equals("androidx.work.impl.foreground.SystemForegroundService")&&service.foreground)return true;
        return false;
    }
    @Test public void foregroundWorkerSurvivesActivityRecreationWithPersistedGrantAndVerifiedExport()throws Exception{
        Uri source=fixture("single");byte[] original=bytes(context,source);
        try(Cursor cursor=context.getContentResolver().query(source,new String[]{"owner_uid","caller_uid"},null,null,null)){assertNotNull(cursor);assertTrue(cursor.moveToFirst());assertNotEquals(Process.myUid(),cursor.getInt(0));assertEquals(Process.myUid(),cursor.getInt(1));}
        assertTrue(context.getContentResolver().getPersistedUriPermissions().stream().anyMatch(permission->permission.getUri().equals(source)&&permission.isReadPermission()));
        UUID upload;
        try(TransferAcceptanceApplication.Hold hold=application.backend.holdNext()){
            upload=start(uploadData(source,false));assertTrue("Actual Worker must reach the owned transfer barrier",hold.entered.await(25,TimeUnit.SECONDS));
            assertTrue(TransferLease.active());await("Actual WorkManager foreground service not observed",this::foregroundService,10);
            File prepared=application.backend.lastPrepared.get();assertNotNull(prepared);assertArrayEquals(original,Files.readAllBytes(prepared.toPath()));
            assertEquals(0600,android.system.Os.stat(prepared.getPath()).st_mode&0777);assertEquals(0700,android.system.Os.stat(job(upload).getPath()).st_mode&0777);assertEquals(0600,android.system.Os.stat(new File(job(upload),"account.receiver").getPath()).st_mode&0777);
            WorkInfo running=manager.getWorkInfoById(upload).get(10,TimeUnit.SECONDS);assertEquals(WorkInfo.State.RUNNING,running.getState());await("Actual preparation progress was not persisted",()->manager.getWorkInfoById(upload).get(10,TimeUnit.SECONDS).getProgress().getLong("done",0)>0,10);assertTrue(running.getProgress().getInt("percent",0)<100);
            scenario.moveToState(Lifecycle.State.CREATED);assertTrue(TransferLease.active());scenario.moveToState(Lifecycle.State.RESUMED);scenario.recreate();
            AtomicReference<Uri> restored=new AtomicReference<>();scenario.onActivity(activity->restored.set(activity.selected));assertEquals(source,restored.get());assertArrayEquals(original,bytes(context,source));
        }
        assertEquals(WorkInfo.State.SUCCEEDED,finished(upload).getState());assertFalse(job(upload).exists());assertArrayEquals(original,bytes(context,source));
        WorkInfo restored=download(application.backend.item());assertEquals(WorkInfo.State.SUCCEEDED,restored.getState());File privateCopy=new File(restored.getOutputData().getString("path"));assertArrayEquals(original,Files.readAllBytes(privateCopy.toPath()));
        Uri destination=fixture("output");MainActivity.exportVerifiedArchive(context,privateCopy.getPath(),destination);assertArrayEquals(original,bytes(context,destination));
        for(String mode:new String[]{"output-failure","output-partial"}){
            Uri refused=fixture(mode);try{MainActivity.exportVerifiedArchive(context,privateCopy.getPath(),refused);fail("Output failure was silently successful: "+mode);}catch(IOException expected){assertArrayEquals(original,Files.readAllBytes(privateCopy.toPath()));}
        }
        Uri untouched=fixture("output");try{MainActivity.exportVerifiedArchive(context,context.getApplicationInfo().sourceDir,untouched);fail("An unverified outside-job file was exported");}catch(IOException expected){assertEquals(0,bytes(context,untouched).length);}
        assertArrayEquals(original,bytes(context,source));
    }
    @Test public void revokedReadAndForeignWorkspaceFailWithoutPublishing()throws Exception{
        Uri source=fixture("single");byte[] original=bytes(context,source);AtomicReference<Integer> before=new AtomicReference<>();
        scenario.onActivity(activity->{before.set(activity.results.get());activity.revokeFixture(owner,source);});
        await("Owned grant was not revoked",()->{AtomicReference<Boolean> done=new AtomicReference<>(false);scenario.onActivity(activity->done.set(activity.results.get()>before.get()));return done.get();},15);
        UUID revoked=start(uploadData(source,false));assertEquals(WorkInfo.State.FAILED,finished(revoked).getState());assertEquals(0,application.backend.uploads.get());assertTrue(job(revoked).exists());
        scenario.onActivity(activity->{before.set(activity.results.get());activity.regrantFixture(owner,source);});
        await("Owned source could not be regranted for retention verification",()->{AtomicReference<Boolean> done=new AtomicReference<>(false);scenario.onActivity(activity->done.set(activity.results.get()>before.get()));return done.get();},15);
        assertArrayEquals(original,bytes(context,source));
        UUID refused=start(uploadData(fixture("read-failure"),false));assertEquals(WorkInfo.State.FAILED,finished(refused).getState());assertEquals(0,application.backend.uploads.get());assertTrue(job(refused).exists());
        WorkInfo foreign=download(new JSONObject().put("workspace","bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));assertEquals(WorkInfo.State.FAILED,foreign.getState());assertEquals(0,application.backend.downloads.get());assertEquals(150*1024,original.length);
    }
    @Test public void damagedCarrierDownloadFailsAndRetainsItsPrivateJob()throws Exception{
        UUID uploaded=start(uploadData(fixture("empty"),true));assertEquals(WorkInfo.State.SUCCEEDED,finished(uploaded).getState());JSONObject item=application.backend.item();application.backend.corrupt();
        OneTimeWorkRequest work=request(new Data.Builder().putString("subject",TransferAcceptanceApplication.SUBJECT).putString("workspace",TransferAcceptanceApplication.WORKSPACE).putString("action","download").putString("item",item.toString()).build());manager.enqueue(work).getResult().get(10,TimeUnit.SECONDS);assertEquals(WorkInfo.State.FAILED,finished(work.getId()).getState());assertTrue(job(work.getId()).isDirectory());assertFalse(new File(job(work.getId()),"verified.archive").exists());
    }
    @Test public void failedPredecessorPropagatesToAlreadyQueuedSelections()throws Exception{
        Uri source=fixture("single");byte[] original=bytes(context,source);String chain="owned-chain-"+UUID.randomUUID();
        OneTimeWorkRequest first=request(uploadData(source,false)),second=request(uploadData(source,false)),third=request(uploadData(source,false));
        try(TransferAcceptanceApplication.Hold hold=application.backend.holdNext(true)){
            manager.enqueueUniqueWork(chain,ExistingWorkPolicy.APPEND_OR_REPLACE,first).getResult().get(10,TimeUnit.SECONDS);assertTrue(hold.entered.await(25,TimeUnit.SECONDS));
            manager.enqueueUniqueWork(chain,ExistingWorkPolicy.APPEND_OR_REPLACE,second).getResult().get(10,TimeUnit.SECONDS);manager.enqueueUniqueWork(chain,ExistingWorkPolicy.APPEND_OR_REPLACE,third).getResult().get(10,TimeUnit.SECONDS);
            assertEquals(WorkInfo.State.BLOCKED,manager.getWorkInfoById(second.getId()).get(10,TimeUnit.SECONDS).getState());
        }
        for(OneTimeWorkRequest work:new OneTimeWorkRequest[]{first,second,third})assertEquals(WorkInfo.State.FAILED,finished(work.getId()).getState());
        assertEquals(1,application.backend.uploads.get());assertArrayEquals(original,bytes(context,source));assertTrue(job(first.getId()).exists());
    }
}
