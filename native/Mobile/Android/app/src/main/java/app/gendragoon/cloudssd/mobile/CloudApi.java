package app.gendragoon.cloudssd.mobile;

import android.content.Context;
import org.json.*;
import javax.net.ssl.HttpsURLConnection;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/** Current Receiver/Control API only. No Firebase or plaintext v3 transport. */
final class CloudApi {
    static final String ORIGIN="https://api.red-xai.com",ISSUER="https://red-xai.com";
    static final int CHUNK=64*1024;
    final Context context;final String uid;
    CloudApi(Context context,String subject){if(subject==null||TextChecks.isBlank(subject))throw new IllegalArgumentException("Connect Red-XAI first.");this.context=context.getApplicationContext();uid=subject;}
    static final class Failure extends IOException {final int status;Failure(int status,String message){super(message);this.status=status;}}
    static final class Response {final int status;final byte[] body;Response(int status,byte[] body){this.status=status;this.body=body;}JSONObject json()throws JSONException{return body.length==0?new JSONObject():new JSONObject(new String(body,StandardCharsets.UTF_8));}}
    static String authorization(String bearer)throws Failure{if(bearer==null||TextChecks.isBlank(bearer)||bearer.indexOf('\r')>=0||bearer.indexOf('\n')>=0)throw new Failure(0,"No sign-in token. Nothing was sent.");return "Bearer "+bearer;}
    static String sha(byte[] value){try{byte[] digest=MessageDigest.getInstance("SHA-256").digest(value);StringBuilder out=new StringBuilder();for(byte b:digest)out.append(String.format(Locale.ROOT,"%02x",b&255));return out.toString();}catch(Exception e){throw new IllegalStateException("SHA-256 unavailable",e);}}
    static String workspace(String id)throws Failure{if(id==null||!id.matches("[a-f0-9]{32}"))throw new Failure(400,"Invalid MachineNote.");return "/v1/receivers/me/workspaces/"+id;}
    JSONObject get(String path)throws Exception{return request(path,"GET",null).json();}
    Response request(String path,String method,JSONObject body)throws Exception{
        if(path==null||!path.startsWith("/")||path.startsWith("//")||path.contains("\\")||path.contains("..")||path.contains("#")||path.length()>4096)throw new Failure(400,"Invalid Red-XAI route.");
        if(!(path.startsWith("/v1/receivers/")||path.startsWith("/gendragoon/v2/")))throw new Failure(400,"Unsupported Red-XAI route.");
        String token=RedXSession.access(context,uid,false);Response result=exchange(ORIGIN+path,method,body,token,2*1024*1024);
        if(result.status==401){token=RedXSession.access(context,uid,true);result=exchange(ORIGIN+path,method,body,token,2*1024*1024);}
        if(result.status<200||result.status>=300)throw new Failure(result.status,error(result));return result;
    }
    static String error(Response response){try{String code=response.json().optString("error","");if(code.matches("[a-z0-9_]{1,80}"))return "Red-XAI request failed: "+code+" (HTTP "+response.status+").";}catch(Exception ignored){}return "Red-XAI request failed (HTTP "+response.status+").";}
    static Response exchange(String url,String method,JSONObject body,String bearer,int maximum)throws Exception{
        URL target=new URL(url);if(!target.getProtocol().equals("https")||target.getPort()!=-1||target.getUserInfo()!=null||!Set.of("api.red-xai.com","red-xai.com").contains(target.getHost()))throw new Failure(0,"Untrusted Red-XAI endpoint.");
        HttpsURLConnection connection=(HttpsURLConnection)target.openConnection();
        try{connection.setInstanceFollowRedirects(false);connection.setUseCaches(false);connection.setConnectTimeout(30000);connection.setReadTimeout(45000);connection.setRequestMethod(method);connection.setRequestProperty("Accept","application/json");connection.setRequestProperty("Accept-Encoding","identity");if(bearer!=null)connection.setRequestProperty("Authorization",authorization(bearer));
            if(body!=null){byte[] data=body.toString().getBytes(StandardCharsets.UTF_8);connection.setDoOutput(true);connection.setRequestProperty("Content-Type","application/json");connection.setFixedLengthStreamingMode(data.length);try(OutputStream output=connection.getOutputStream()){output.write(data);}}
            int status=connection.getResponseCode();ByteArrayOutputStream output=new ByteArrayOutputStream();InputStream raw=status<400?connection.getInputStream():connection.getErrorStream();if(raw!=null)try(InputStream input=raw){byte[] buffer=new byte[8192];int n;while((n=input.read(buffer))!=-1){if(output.size()+n>maximum)throw new Failure(0,"Red-XAI response exceeded its safety limit.");output.write(buffer,0,n);}}return new Response(status,output.toByteArray());
        }finally{connection.disconnect();}
    }
}
