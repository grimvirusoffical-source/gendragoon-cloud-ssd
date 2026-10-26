package app.gendragoon.cloudssd.mobile;

import android.app.Application;
import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.*;
import com.chaquo.python.PyObject;
import com.chaquo.python.Python;
import java.io.File;
import java.io.IOException;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.json.*;

/** Debug APK only. The release public Worker constructor cannot select this backend. */
public final class TransferAcceptanceApplication extends Application implements Configuration.Provider {
    public static final String SUBJECT="PUBLIC-ANDROID-TRANSFER-FIXTURE",WORKSPACE="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    final FixtureBackend backend=new FixtureBackend(this);
    @NonNull @Override public Configuration getWorkManagerConfiguration(){
        return new Configuration.Builder().setWorkerFactory(new WorkerFactory(){
            @Override public ListenableWorker createWorker(@NonNull Context context,@NonNull String name,@NonNull WorkerParameters parameters){
                return TransferWorker.class.getName().equals(name)?new TransferWorker(context,parameters,backend):null;
            }
        }).build();
    }
    static final class Hold implements AutoCloseable {
        final CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1);
        final boolean fail;Hold(boolean fail){this.fail=fail;}
        @Override public void close(){release.countDown();}
    }
    static final class FixtureBackend implements TransferWorker.Backend {
        private final Context context;
        private PyObject fixture;
        final AtomicInteger uploads=new AtomicInteger(),downloads=new AtomicInteger();
        final AtomicReference<Hold> nextHold=new AtomicReference<>();
        final AtomicReference<File> lastPrepared=new AtomicReference<>();
        FixtureBackend(Context context){this.context=context;}
        private synchronized PyObject fixture()throws Exception{
            if(fixture==null){
                CryptoRuntime.module(context);
                File directory=new File(context.getFilesDir(),"transfer-fixture-"+UUID.randomUUID());
                fixture=Python.getInstance().getModule("gendragoon_android_fixture").callAttr("TransferFixture",directory.getCanonicalPath(),RedXSession.receiver(SUBJECT),WORKSPACE);
            }
            return fixture;
        }
        private void identity(String subject,String workspace)throws IOException{
            if(!SUBJECT.equals(subject)||!WORKSPACE.equals(workspace))throw new IOException("Fixture account changed.");
        }
        public JSONObject configuration(String subject,String workspace)throws Exception{identity(subject,workspace);return new JSONObject(fixture().callAttr("configuration").toString());}
        public JSONObject receiverState(String subject)throws Exception{identity(subject,WORKSPACE);return new JSONObject().put("workspaces",new JSONArray().put(new JSONObject().put("id",WORKSPACE).put("active",true).put("readOnly",false)));}
        public String upload(JSONObject config,File source,File stage,String subject,CryptoRuntime.Reporter reporter)throws Exception{
            identity(subject,config.getString("workspaceId"));uploads.incrementAndGet();lastPrepared.set(source);
            Hold hold=nextHold.getAndSet(null);
            if(hold!=null){hold.entered.countDown();if(!hold.release.await(45,TimeUnit.SECONDS))throw new IOException("Owned fixture hold was not released.");if(hold.fail)throw new IOException("Owned fixture network failure after admission.");}
            return fixture().callAttr("upload",source.getCanonicalPath(),stage.getCanonicalPath(),reporter).toString();
        }
        public String download(JSONObject config,JSONObject item,File stage,String subject,CryptoRuntime.Reporter reporter)throws Exception{
            identity(subject,config.getString("workspaceId"));downloads.incrementAndGet();
            return fixture().callAttr("download",item.toString(),stage.getCanonicalPath(),reporter).toString();
        }
        synchronized void reset()throws Exception{
            if(TransferLease.active())throw new IOException("An actual fixture Worker body remains active.");
            if(nextHold.get()!=null)throw new IOException("An owned fixture hold remains installed.");
            fixture=null;uploads.set(0);downloads.set(0);lastPrepared.set(null);
        }
        JSONObject item()throws Exception{return new JSONObject(fixture().callAttr("item").toString());}
        void corrupt()throws Exception{fixture().callAttr("corrupt");}
        Hold holdNext()throws Exception{return holdNext(false);}
        Hold holdNext(boolean fail)throws Exception{Hold hold=new Hold(fail);if(!nextHold.compareAndSet(null,hold))throw new IOException("A fixture hold is already installed.");return hold;}
    }
}
