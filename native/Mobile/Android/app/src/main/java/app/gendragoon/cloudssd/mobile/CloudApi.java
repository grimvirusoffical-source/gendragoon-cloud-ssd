package app.gendragoon.cloudssd.mobile;

import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseUser;
import com.google.android.gms.tasks.Tasks;
import org.json.*;
import javax.net.ssl.HttpsURLConnection;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.TimeUnit;

final class CloudApi {
    static final String ORIGIN="https://gendragoon-free-10068843866.us-central1.run.app";
    static final int CHUNK=8*1024*1024;
    final String uid;
    CloudApi(String uid){if(uid==null||uid.isBlank())throw new IllegalArgumentException("Sign in first");this.uid=uid;}
    static final class Failure extends IOException {final int status;Failure(int status,String message){super(message);this.status=status;}}
    static final class Response {final int status;final byte[] body;final Map<String,List<String>> headers;
        Response(int status,byte[] body,Map<String,List<String>> headers){this.status=status;this.body=body;this.headers=headers;}
        JSONObject json()throws JSONException{return body.length==0?new JSONObject():new JSONObject(new String(body,StandardCharsets.UTF_8));}
        String header(String key){for(Map.Entry<String,List<String>> e:headers.entrySet())if(e.getKey()!=null&&e.getKey().equalsIgnoreCase(key)&&!e.getValue().isEmpty())return e.getValue().get(0);return "";}
    }
    String token(boolean force)throws Exception{
        FirebaseUser user=FirebaseAuth.getInstance().getCurrentUser();if(user==null||!uid.equals(user.getUid()))throw new Failure(401,"Your account changed. Sign in again.");
        String token=Tasks.await(user.getIdToken(force),30,TimeUnit.SECONDS).getToken();
        if(token==null||FirebaseAuth.getInstance().getCurrentUser()==null||!uid.equals(FirebaseAuth.getInstance().getCurrentUser().getUid()))throw new Failure(401,"Sign in again to continue.");return token;
    }
    static String workspace(String id)throws Failure{
        if(!"free".equals(id)&&!id.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"))throw new Failure(400,"Invalid workspace.");return "/v3/cloud/"+id;
    }
    Response request(String path,String method,JSONObject data)throws Exception{return request(path,method,data==null?null:data.toString().getBytes(StandardCharsets.UTF_8),data==null?Map.of():Map.of("Content-Type","application/json"));}
    Response request(String path,String method,byte[] body,Map<String,String> headers)throws Exception{
        if(!path.startsWith("/")||path.startsWith("//")||path.contains("\\"))throw new Failure(400,"Invalid cloud route.");
        Exception last=new IOException("Transfer failed.");
        for(int attempt=0;attempt<5;attempt++){
            if(Thread.currentThread().isInterrupted())throw new InterruptedException("Paused");
            try{
                Response response=exchange(ORIGIN+path,method,body,headers,attempt>0);
                String text=new String(response.body,StandardCharsets.UTF_8);
                CloudSignals.Route routed=CloudSignals.route(response.status,text,method);
                if(routed.destination==CloudSignals.Destination.LOCK_SCREEN)throw new WorkspaceLocked(routed.lock);
                if(response.status>=200&&response.status<300)return response;
                String message=routed.toast==null?"Cloud request failed (HTTP "+response.status+").":routed.toast;
                Failure error=new Failure(response.status,message);
                if(!List.of(401,408,429,500,502,503,504).contains(response.status))throw error;
                last=error;
            }catch(Failure error){if(!List.of(401,408,429,500,502,503,504).contains(error.status))throw error;last=error;}
            catch(IOException error){last=error;}
            if(attempt<4)Thread.sleep(250L*(1L<<attempt));
        }
        throw last;
    }
    Response exchange(String url,String method,byte[] body,Map<String,String> headers,boolean force)throws Exception{
        return exchangeAuthorized(url,method,body,headers,token(force));
    }
    Response exchangeAuthorized(String url,String method,byte[] body,Map<String,String> headers,String bearer)throws Exception{
        URL target=new URL(url);
        if(!target.getProtocol().equals("https")||!Set.of("gendragoon-free-10068843866.us-central1.run.app","firestore.googleapis.com").contains(target.getHost()))throw new Failure(400,"Untrusted endpoint.");
        HttpsURLConnection c=(HttpsURLConnection)target.openConnection();
        try{
            c.setInstanceFollowRedirects(false);c.setConnectTimeout(30000);c.setReadTimeout(120000);c.setRequestMethod(method);c.setUseCaches(false);
            c.setRequestProperty("Authorization","Bearer "+bearer);c.setRequestProperty("Accept","application/json");c.setRequestProperty("Accept-Encoding","identity");
            for(Map.Entry<String,String> e:headers.entrySet())c.setRequestProperty(e.getKey(),e.getValue());
            if(body!=null){c.setDoOutput(true);c.setFixedLengthStreamingMode(body.length);try(OutputStream out=c.getOutputStream()){out.write(body);}}
            int status=c.getResponseCode();byte[] bytes=new byte[0];
            if(!method.equals("HEAD")||status==423){
                InputStream raw=status<400?c.getInputStream():c.getErrorStream();
                if(raw!=null)try(InputStream in=raw;ByteArrayOutputStream out=new ByteArrayOutputStream()){
                    byte[] buffer=new byte[64*1024];int n,total=0;
                    while((n=in.read(buffer))>=0){if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("Paused");total+=n;if(total>CHUNK+1024*1024)throw new IOException("Oversized response rejected.");out.write(buffer,0,n);}bytes=out.toByteArray();
                }
            }
            return new Response(status,bytes,c.getHeaderFields());
        }finally{c.disconnect();}
    }
    /**
     * One-shot {@code DELETE /v2/account}. Returns {@code 202 {"jobId"}}. Poll
     * {@link AccountActions#DELETION_STATUS_PATH} for {@code queued | running | done | failed}.
     * {@code 401 reauth_required} asks for a new sign-in. {@code 401 invalid_token} returns to
     * sign-in. Neither wipes local keys. Uses {@code freshToken} as given: no session refresh and no retry.
     */
    AccountActions.HttpBody deleteAccountCall(String freshToken)throws Exception{
        if(freshToken==null||freshToken.isEmpty())throw new Failure(401,"Sign in again to continue.");
        Response response=exchangeAuthorized(ORIGIN+"/v2/account","DELETE",null,Map.of(),freshToken);
        return AccountActions.parse(response.status,new String(response.body,StandardCharsets.UTF_8));
    }
    /** One-shot poll of {@link AccountActions#DELETION_STATUS_PATH}. A 401 is returned and does not wipe. */
    AccountActions.HttpBody pollDeletion(String path)throws Exception{
        if(!AccountActions.safeAccountPath(path))throw new Failure(400,"Invalid deletion status route.");
        try{
            Response response=exchangeAuthorized(ORIGIN+path,"GET",null,Map.of(),token(false));
            return AccountActions.parse(response.status,new String(response.body,StandardCharsets.UTF_8));
        }catch(Failure error){
            if(error.status==401)return new AccountActions.HttpBody(401,"",error.getMessage()==null?null:"reauth_required",null,null);
            throw error;
        }
    }
    /**
     * {@code DELETE /v2/workspaces/{id}}. Uses {@link #request}, so HTTP 423 {@code workspace_lock}
     * still opens the lock screen. Hosted files are removed by the server. Bring-your-own storage is not modified.
     */
    void deleteWorkspace(String id)throws Exception{
        if(id==null||(!"free".equals(id)&&!id.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")))throw new Failure(400,"Invalid workspace.");
        request("/v2/workspaces/"+id,"DELETE",(JSONObject)null);
    }
    /**
     * Merge is not final and this method performs no request.
     * Expected later call: {@code POST /v2/workspaces/{targetId}/merge} with {@code {"sourceId"}}.
     * Duplicate files are kept as {@code name (from <source>)}.
     */
    static String mergeWorkspaces(String targetId,String sourceId,String sourceName){
        if(targetId==null||sourceId==null)return AccountActions.mergeUnavailable(sourceName);
        return AccountActions.mergeUnavailable(sourceName);
    }
    JSONObject get(String path)throws Exception{return request(path,"GET",(JSONObject)null).json();}
    List<JSONObject> files(String workspace)throws Exception{
        List<JSONObject> files=new ArrayList<>();String cursor="";Set<String> seen=new HashSet<>();
        do{
            JSONObject result=get(workspace(workspace)+"/files"+(cursor.isEmpty()?"":"?cursor="+URLEncoder.encode(cursor,StandardCharsets.UTF_8)));
            JSONArray rows=result.getJSONArray("files");for(int n=0;n<rows.length();n++)files.add(rows.getJSONObject(n));
            cursor=result.isNull("nextCursor")?"":result.optString("nextCursor","");
            if(!cursor.isEmpty()&&(!cursor.matches("[a-f0-9-]{36}")||!seen.add(cursor)))throw new Failure(400,"Invalid file cursor.");
        }while(!cursor.isEmpty());return files;
    }
    boolean termsAccepted()throws Exception{
        Response response=exchange("https://firestore.googleapis.com/v1/projects/gendragoonssd/databases/(default)/documents/accepted_terms/"+URLEncoder.encode(uid,StandardCharsets.UTF_8),"GET",null,Map.of(),false);
        if(response.status==404)return false;if(response.status!=200)throw new Failure(response.status,"Terms could not be verified.");
        JSONObject f=response.json().getJSONObject("fields");
        return f.optJSONObject("termsVersion")!=null&&f.optJSONObject("readConfirmed")!=null&&f.optJSONObject("agreed")!=null&&"terms-2026-10-14-v1".equals(f.optJSONObject("termsVersion").optString("stringValue"))&&f.optJSONObject("readConfirmed").optBoolean("booleanValue")&&f.optJSONObject("agreed").optBoolean("booleanValue");
    }
    void acceptTerms()throws Exception{
        JSONObject fields=new JSONObject().put("termsVersion",new JSONObject().put("stringValue","terms-2026-10-14-v1")).put("readConfirmed",new JSONObject().put("booleanValue",true)).put("agreed",new JSONObject().put("booleanValue",true));
        JSONObject write=new JSONObject().put("update",new JSONObject().put("name","projects/gendragoonssd/databases/(default)/documents/accepted_terms/"+uid).put("fields",fields)).put("updateTransforms",new JSONArray().put(new JSONObject().put("fieldPath","acceptedAt").put("setToServerValue","REQUEST_TIME"))).put("currentDocument",new JSONObject().put("exists",false));
        byte[] body=new JSONObject().put("writes",new JSONArray().put(write)).toString().getBytes(StandardCharsets.UTF_8);
        Response response=exchange("https://firestore.googleapis.com/v1/projects/gendragoonssd/databases/(default)/documents:commit","POST",body,Map.of("Content-Type","application/json"),false);
        if(!List.of(200,409).contains(response.status)||!termsAccepted())throw new Failure(response.status,"Agreement was not saved. Please try again.");
    }
    static String sha(byte[] data)throws Exception{byte[] result=MessageDigest.getInstance("SHA-256").digest(data);StringBuilder text=new StringBuilder();for(byte b:result)text.append(String.format(Locale.ROOT,"%02x",b&255));return text.toString();}
}
