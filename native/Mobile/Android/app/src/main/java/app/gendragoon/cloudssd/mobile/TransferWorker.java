package app.gendragoon.cloudssd.mobile;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.database.Cursor;
import android.net.*;
import android.os.*;
import android.provider.OpenableColumns;
import android.provider.DocumentsContract;
import android.util.Base64;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.work.*;
import org.json.*;
import java.io.*;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

public final class TransferWorker extends Worker {
    private static final String CHANNEL="gendragoon-transfers";
    private final Context context;
    private volatile ExecutorService pool;
    private CloudApi api;
    private File preparedArchive;
    private long start,initial;
    private String name="Cloud file";
    public TransferWorker(@NonNull Context context,@NonNull WorkerParameters parameters){super(context,parameters);this.context=context;}
    @NonNull @Override public Result doWork(){
        try{
            api=new CloudApi(getInputData().getString("uid"));
            String action=getInputData().getString("action"),workspace=getInputData().getString("workspace");
            setForegroundAsync(foreground(0,"Preparing secure transfer")).get(30,TimeUnit.SECONDS);
            String output= "upload".equals(action)?upload(workspace,Uri.parse(getInputData().getString("uri"))):download(workspace,new JSONObject(getInputData().getString("file")));
            return Result.success(new Data.Builder().putString("message","Transfer complete").putString("action",action).putString("path",output).putString("uid",api.uid).build());
        }catch(Exception error){
            CloudSignals.FailureNotice notice=CloudSignals.transferFailure(error,isStopped());
            Data.Builder output=new Data.Builder();
            if(notice.route!=null)output.putString("route",notice.route);
            if(notice.message!=null)output.putString("message",notice.message);
            if(notice.lockJson!=null)output.putString("lock",notice.lockJson);
            return Result.failure(output.build());
        }finally{if(pool!=null)pool.shutdownNow();if(preparedArchive!=null)preparedArchive.delete();}
    }
    @Override public void onStopped(){if(pool!=null)pool.shutdownNow();super.onStopped();}
    private void check()throws InterruptedException{if(isStopped()||Thread.currentThread().isInterrupted())throw new InterruptedException("Paused");}
    private ForegroundInfo foreground(int percent,String text){
        NotificationManager manager=(NotificationManager)context.getSystemService(Context.NOTIFICATION_SERVICE);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL,"Cloud transfers",NotificationManager.IMPORTANCE_LOW));
        Notification note=new NotificationCompat.Builder(context,CHANNEL).setSmallIcon(R.drawable.ic_cloud).setContentTitle("GenDragoon · "+name).setContentText(text).setOngoing(true).setOnlyAlertOnce(true)
            .setProgress(100,percent,false).addAction(0,"Pause",WorkManager.getInstance(context).createCancelPendingIntent(getId())).build();
        return Build.VERSION.SDK_INT>=29?new ForegroundInfo(6143,note,ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC):new ForegroundInfo(6143,note);
    }
    private void progress(long done,long total,String phase){
        double seconds=Math.max(.001,(System.nanoTime()-start)/1e9),rate=(done-initial)/seconds;
        int percentage=(int)Math.min(100,done*100/Math.max(1,total));
        String message=phase+" · "+percentage+"%"+(rate>0?String.format(Locale.ROOT," · %.1f MB/s",rate/1e6):"");
        setProgressAsync(new Data.Builder().putLong("done",done).putLong("total",total).putString("message",message).build());
        setForegroundAsync(foreground(percentage,message));
    }
    private int workers(JSONObject configuration)throws Exception{
        int limit=configuration.getJSONObject("transfer").getInt("workers");
        if(limit<1||limit>24||configuration.getJSONObject("transfer").getInt("chunkBytes")!=CloudApi.CHUNK)throw new IOException("Invalid server transfer profile.");
        ConnectivityManager network=(ConnectivityManager)context.getSystemService(Context.CONNECTIVITY_SERVICE);PowerManager power=(PowerManager)context.getSystemService(Context.POWER_SERVICE);
        return getInputData().getBoolean("dataSaver",false)||network.isActiveNetworkMetered()||power.isPowerSaveMode()?1:Math.min(4,limit);
    }
    private SharedPreferences preferences(){return context.getSharedPreferences("gd-transfer-checkpoints",Context.MODE_PRIVATE);}
    private static boolean received(JSONArray ranges,int index)throws JSONException{for(int n=0;n<ranges.length();n++){JSONArray r=ranges.getJSONArray(n);if(index>=r.getInt(0)&&index<=r.getInt(1))return true;}return false;}
    private static JSONArray add(JSONArray ranges,int index)throws JSONException{
        List<int[]> pairs=new ArrayList<>();for(int n=0;n<ranges.length();n++){JSONArray r=ranges.getJSONArray(n);pairs.add(new int[]{r.getInt(0),r.getInt(1)});}pairs.add(new int[]{index,index});pairs.sort(Comparator.comparingInt(r->r[0]));
        List<int[]> merged=new ArrayList<>();for(int[] p:pairs){if(!merged.isEmpty()&&p[0]<=merged.get(merged.size()-1)[1]+1)merged.get(merged.size()-1)[1]=Math.max(merged.get(merged.size()-1)[1],p[1]);else merged.add(p);}
        JSONArray result=new JSONArray();for(int[] p:merged)result.put(new JSONArray().put(p[0]).put(p[1]));return result;
    }
    private static final class Source {String name;long size;String modified;File local;Uri uri;SelectionArchive bundle;}
    private Source source(Uri uri)throws Exception{
        if(uri==null||!"content".equals(uri.getScheme()))throw new IOException("Choose a file with the Android document picker.");
        Source source=new Source();source.uri=uri;source.modified="";
        try(Cursor c=context.getContentResolver().query(uri,null,null,null,null)){
            if(c==null||!c.moveToFirst())throw new IOException("File metadata unavailable.");
            int n=c.getColumnIndex(OpenableColumns.DISPLAY_NAME),s=c.getColumnIndex(OpenableColumns.SIZE),m=c.getColumnIndex("last_modified");
            source.name=n>=0?c.getString(n):"upload.bin";source.size=s>=0&&!c.isNull(s)?c.getLong(s):-1;source.modified=m>=0&&!c.isNull(m)?c.getString(m):"";
        }
        if(source.size<0)throw new IOException("The provider must report a file size before this file can be uploaded.");
        SelectionArchive.safeName(source.name);
        return source;
    }
    private ParcelFileDescriptor.AutoCloseInputStream open(Uri uri)throws IOException{
        ParcelFileDescriptor fd=context.getContentResolver().openFileDescriptor(uri,"r");if(fd==null)throw new IOException("File permission was revoked.");return new ParcelFileDescriptor.AutoCloseInputStream(fd);
    }
    private void makeSeekable(Source source,String key)throws Exception{
        try(ParcelFileDescriptor.AutoCloseInputStream input=open(source.uri)){input.getChannel().position(0);return;}catch(IOException notSeekable){
            File dir=new File(context.getCacheDir(),"gd-inputs");if(!dir.exists()&&!dir.mkdirs())throw new IOException("Input cache unavailable.");
            File target=new File(dir,key+".source");if(target.isFile()&&target.length()==source.size){source.local=target;return;}
            if(dir.getUsableSpace()<source.size+512L*1024*1024)throw new IOException("This provider cannot seek. Free local space for a temporary input copy, or use a local file.");
            File temporary=new File(dir,key+".partial");long total=0;
            try(InputStream in=context.getContentResolver().openInputStream(source.uri);FileOutputStream out=new FileOutputStream(temporary)){
                if(in==null)throw new IOException("Cannot open this file.");byte[] buffer=new byte[64*1024];int n;
                while((n=in.read(buffer))>=0){check();total+=n;if(total>source.size)throw new IOException("Source file grew during caching.");out.write(buffer,0,n);}out.getFD().sync();
            }
            if(total!=source.size)throw new IOException("Source file size changed.");Files.move(temporary.toPath(),target.toPath(),StandardCopyOption.REPLACE_EXISTING);source.local=target;
        }
    }
    private byte[] read(Source source,int index)throws Exception{
        int length=(int)Math.min(CloudApi.CHUNK,source.size-(long)index*CloudApi.CHUNK);byte[] data=new byte[length];int total=0;
        if(source.local!=null){try(RandomAccessFile file=new RandomAccessFile(source.local,"r")){file.seek((long)index*CloudApi.CHUNK);file.readFully(data);}return data;}
        try(ParcelFileDescriptor.AutoCloseInputStream in=open(source.uri)){
            in.getChannel().position((long)index*CloudApi.CHUNK);while(total<length){check();int n=in.read(data,total,length-total);if(n<0)throw new IOException("Source changed during upload.");total+=n;}
        }return data;
    }
    private String upload(String workspace,Uri uri)throws Exception{
        String path=CloudApi.workspace(workspace);JSONObject config=api.get(path+"/config");int parallel=workers(config);
        Source source;
        if(getInputData().getBoolean("folder",false))source=new Source();else source=source(uri);
        if(getInputData().getBoolean("folder",false)||source.size==0){
            SelectionArchive bundle=SelectionArchive.create(context,uri,config.getLong("maxFileBytes"),this::check);
            preparedArchive=bundle.archive;source.bundle=bundle;source.local=bundle.archive;source.uri=uri;source.name=bundle.name;source.size=bundle.archive.length();source.modified=SelectionArchive.digest(new FileInputStream(bundle.archive),this::check);
        }
        name=source.name;if(source.size>config.getLong("maxFileBytes"))throw new IOException("This file exceeds the workspace's limit.");
        String key=CloudApi.sha((api.uid+"|"+workspace+"|"+uri+"|"+source.name+"|"+source.size+"|"+source.modified).getBytes(StandardCharsets.UTF_8));
        String id=preferences().getString("upload:"+key,null);if(id==null){id=UUID.randomUUID().toString();if(!preferences().edit().putString("upload:"+key,id).commit())throw new IOException("Resume storage unavailable.");}
        final String uploadId=id;
        JSONObject job=api.request(path+"/uploads","POST",new JSONObject().put("requestId",id).put("name",source.name).put("sizeBytes",source.size)).json();
        if(!id.equals(job.getString("uploadId"))||job.getInt("chunkBytes")!=CloudApi.CHUNK)throw new IOException("Invalid upload session.");
        if("completed".equals(job.getString("status"))){verifyOffload(workspace,source,id);preferences().edit().remove("upload:"+key).apply();return "";}
        if(!List.of("active","assembling").contains(job.getString("status"))){preferences().edit().remove("upload:"+key).apply();throw new IOException("The old upload expired. Select the file again.");}
        int total=job.getInt("totalChunks");if(total!=(source.size+CloudApi.CHUNK-1)/CloudApi.CHUNK)throw new IOException("Invalid chunk count.");
        long done=job.getLong("uploadedBytes");initial=done;start=System.nanoTime();JSONArray saved=job.getJSONArray("receivedRanges");
        if("active".equals(job.getString("status"))){
            if(source.local==null)makeSeekable(source,key);pool=Executors.newFixedThreadPool(parallel);CompletionService<Integer> completion=new ExecutorCompletionService<>(pool);
            int next=0,inFlight=0;
            while(next<total||inFlight>0){
                check();while(inFlight<parallel&&next<total){int index=next++;if(received(saved,index))continue;
                    completion.submit(()->{check();byte[] data=read(source,index);api.request(path+"/uploads/"+uploadId+"/chunks/"+index,"PUT",data,Map.of("Content-Type","application/octet-stream","X-Chunk-SHA256",CloudApi.sha(data)));return data.length;});inFlight++;
                }
                if(inFlight>0){done+=completion.take().get();inFlight--;progress(done,source.size,"Uploading");}
            }
            if(source.bundle!=null)source.bundle.verifyOriginal(context,this::check);else{Source current=source(uri);if(current.size!=source.size||!current.modified.equals(source.modified))throw new IOException("The source changed. Original retained; choose it again to upload a fresh version.");}
        }
        while(true){check();CloudApi.Response finalResult=api.request(path+"/uploads/"+id+"/finalize","POST",new JSONObject());if(finalResult.status==200)break;if(finalResult.status!=202)throw new IOException("Unexpected cloud finalization response.");progress(source.size,source.size,"Verifying cloud file");Thread.sleep(1000);}
        verifyOffload(workspace,source,id);preferences().edit().remove("upload:"+key).apply();if(source.local!=null)source.local.delete();progress(source.size,source.size,getInputData().getBoolean("removeOriginal",false)?"Read-back verified; selected original removed":"Saved and verified; original retained");return "";
    }
    private void verifyOffload(String workspace,Source source,String id)throws Exception{
        if(!getInputData().getBoolean("removeOriginal",false))return;
        check();progress(source.size,source.size,"Checking complete cloud restore before removing original");
        if(pool!=null){pool.shutdown();if(!pool.awaitTermination(30,TimeUnit.SECONDS))throw new IOException("Transfer workers have not stopped. Original retained.");}
        String before=SelectionArchive.digest(source.local!=null?new FileInputStream(source.local):context.getContentResolver().openInputStream(source.uri),this::check);
        JSONObject item=new JSONObject().put("id",id).put("name",source.name).put("sizeBytes",source.size);
        File restored=new File(download(workspace,item,true));
        try{
            if(!before.equals(SelectionArchive.digest(new FileInputStream(restored),this::check)))throw new IOException("Cloud read-back differs. Original retained.");
            Uri original=source.uri;
            if(source.bundle!=null){source.bundle.verify(restored,this::check);source.bundle.verifyOriginal(context,this::check);original=source.bundle.root;}
            else if(!before.equals(SelectionArchive.digest(context.getContentResolver().openInputStream(original),this::check)))throw new IOException("Original changed after upload. It was retained.");
            check();
            if(!DocumentsContract.isDocumentUri(context,original)||!DocumentsContract.deleteDocument(context.getContentResolver(),original))throw new IOException("Cloud copy verified, but the document provider did not allow original removal. Original retained.");
        }finally{restored.delete();}
    }
    private static final class Chunk {int index;byte[] data;Chunk(int index,byte[] data){this.index=index;this.data=data;}}
    private String download(String workspace,JSONObject item)throws Exception{return download(workspace,item,false);}
    private String download(String workspace,JSONObject item,boolean verificationOnly)throws Exception{
        String id=item.getString("id");if(!id.matches("[a-f0-9-]{36}"))throw new IOException("Invalid file.");
        name=item.getString("name");if(TextChecks.isBlank(name)||name.contains("/")||name.contains("\\")||name.equals(".")||name.equals(".."))throw new IOException("Unsafe file name.");
        long size=item.getLong("sizeBytes");if(size<=0)throw new IOException("Invalid file size.");
        String path=CloudApi.workspace(workspace),route=path+"/files/"+id+"/download";JSONObject config=api.get(path+"/config");int parallel=workers(config);
        CloudApi.Response head=api.request(route,"HEAD",(JSONObject)null);String etag=head.header("ETag");if(etag.isEmpty()||!Long.toString(size).equals(head.header("Content-Length")))throw new IOException("File metadata changed. Refresh your library.");
        String key=CloudApi.sha((api.uid+"|"+workspace+"|"+id).getBytes(StandardCharsets.UTF_8));File dir=new File(context.getCacheDir(),"gd-downloads");if(!dir.exists()&&!dir.mkdirs())throw new IOException("Cache unavailable.");
        File output=new File(dir,key+".part");JSONObject checkpoint;
        try{checkpoint=new JSONObject(preferences().getString("download:"+key,"{}"));}catch(JSONException ignored){checkpoint=new JSONObject();}
        if(!etag.equals(checkpoint.optString("etag"))||checkpoint.optLong("size")!=size||!output.exists()){checkpoint=new JSONObject().put("etag",etag).put("size",size).put("ranges",new JSONArray());if(output.exists()&&!output.delete())throw new IOException("Cannot reset stale download cache.");}
        JSONArray ranges=checkpoint.getJSONArray("ranges"),initialRanges=new JSONArray(ranges.toString());int total=(int)((size+CloudApi.CHUNK-1)/CloudApi.CHUNK);long done=0;
        for(int n=0;n<ranges.length();n++){JSONArray r=ranges.getJSONArray(n);for(int i=r.getInt(0);i<=r.getInt(1);i++)done+=Math.min(CloudApi.CHUNK,size-(long)i*CloudApi.CHUNK);}
        if(dir.getUsableSpace()<size-done+512L*1024*1024)throw new IOException("Free more local storage before restoring this file.");
        initial=done;start=System.nanoTime();pool=Executors.newFixedThreadPool(parallel);CompletionService<Chunk> completion=new ExecutorCompletionService<>(pool);int next=0,inFlight=0;
        try(RandomAccessFile file=new RandomAccessFile(output,"rw")){
            while(next<total||inFlight>0){
                check();while(inFlight<parallel&&next<total){int index=next++;if(received(initialRanges,index))continue;
                    completion.submit(()->{long first=(long)index*CloudApi.CHUNK,last=Math.min(size-1,first+CloudApi.CHUNK-1);CloudApi.Response r=api.request(route,"GET",null,Map.of("Range","bytes="+first+"-"+last,"If-Match",etag));
                        if(r.status!=206||!etag.equals(r.header("ETag"))||!r.header("Content-Range").equals("bytes "+first+"-"+last+"/"+size)||r.body.length!=last-first+1)throw new IOException("Download range verification failed.");return new Chunk(index,r.body);});inFlight++;
                }
                if(inFlight>0){Chunk piece=completion.take().get();inFlight--;file.seek((long)piece.index*CloudApi.CHUNK);file.write(piece.data);file.getFD().sync();ranges=add(ranges,piece.index);checkpoint.put("ranges",ranges);if(!preferences().edit().putString("download:"+key,checkpoint.toString()).commit())throw new IOException("Could not save resume state.");done+=piece.data.length;progress(done,size,"Restoring");}
            }file.setLength(size);file.getFD().sync();
        }
        if(!item.isNull("crc32c")&&!item.optString("crc32c","").isEmpty()){
            int crc=0xffffffff;try(InputStream input=new FileInputStream(output)){byte[] buffer=new byte[64*1024];int n;while((n=input.read(buffer))>=0){check();for(int i=0;i<n;i++){crc^=buffer[i]&255;for(int bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)!=0?0x82f63b78:0);}}}
            String computed=Base64.encodeToString(ByteBuffer.allocate(4).putInt(crc^0xffffffff).array(),Base64.NO_WRAP);
            if(!computed.equals(item.getString("crc32c"))){output.delete();preferences().edit().remove("download:"+key).apply();throw new IOException("Checksum mismatch. The destination was not changed.");}
        }
        if(verificationOnly){preferences().edit().remove("download:"+key).apply();return output.getAbsolutePath();}
        File exportDir=new File(context.getFilesDir(),"exports/"+CloudApi.sha(api.uid.getBytes(StandardCharsets.UTF_8))+"/"+id);if(!exportDir.exists()&&!exportDir.mkdirs())throw new IOException("Export directory unavailable.");
        File destination=new File(exportDir,name);Files.move(output.toPath(),destination.toPath(),StandardCopyOption.REPLACE_EXISTING);preferences().edit().remove("download:"+key).apply();progress(size,size,"File verified and restored");return destination.getAbsolutePath();
    }
}
