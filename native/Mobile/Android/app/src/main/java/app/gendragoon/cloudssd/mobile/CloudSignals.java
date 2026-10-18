package app.gendragoon.cloudssd.mobile;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

/** Classifies cloud HTTP results so every call site treats workspace locks the same way. */
final class CloudSignals {
    static final String ROUTE_LOCK="workspace_lock";
    static final String CODE_LOCK="workspace_lock";
    static final long FRESH_SIGN_IN_MS=5L*60L*1000L;

    enum Destination { CONTINUE, LOCK_SCREEN, GENERIC_ERROR }

    /** Where a response should go. {@code toast} is null when the user must not see a generic error. */
    static final class Route {
        final Destination destination;
        final String toast;
        final WorkspaceLock lock;
        final String raw;
        final int status;
        final String method;
        Route(Destination destination,String toast,WorkspaceLock lock,String raw,int status,String method){
            this.destination=destination;this.toast=toast;this.lock=lock;this.raw=raw;this.status=status;this.method=method==null?"":method;
        }
    }

    private CloudSignals(){}

    static Route route(int status,String body,String method){
        String verb=method==null?"":method;
        WorkspaceLock lock=workspaceLock(status,body);
        if(lock!=null)return new Route(Destination.LOCK_SCREEN,null,lock,body==null?"":body,status,verb);
        if(status>=200&&status<300)return new Route(Destination.CONTINUE,null,null,body,status,verb);
        String message=JsonFields.string(body,"error");
        if(message==null||message.isEmpty()||CODE_LOCK.equals(message))message="Cloud request failed (HTTP "+status+").";
        return new Route(Destination.GENERIC_ERROR,message,null,body,status,verb);
    }

    static WorkspaceLock workspaceLock(int status,String body){
        if(status!=423||!CODE_LOCK.equals(JsonFields.string(body,"error")))return null;
        return new WorkspaceLock(JsonFields.workspaces(body),body==null?"":body);
    }

    static boolean shouldToast(Exception error){return !(error instanceof WorkspaceLocked)&&error.getMessage()!=null;}

    /** Firebase ID tokens carry {@code auth_time} in seconds. Missing or older than five minutes is not fresh. */
    static boolean freshSignIn(String jwt,long nowMs){
        Long auth=authTimeMillis(jwt);
        return auth!=null&&nowMs>=auth&&nowMs-auth<=FRESH_SIGN_IN_MS;
    }

    static Long authTimeMillis(String jwt){
        if(jwt==null)return null;
        String[] parts=jwt.split("\\.");
        if(parts.length<2)return null;
        try{
            byte[] json=Base64.getUrlDecoder().decode(pad(parts[1]));
            String payload=new String(json,StandardCharsets.UTF_8);
            String seconds=JsonFields.number(payload,"auth_time");
            if(seconds==null)return null;
            return Long.parseLong(seconds)*1000L;
        }catch(RuntimeException error){return null;}
    }

    private static String pad(String value){
        int mod=value.length()%4;
        return mod==0?value:value+"====".substring(mod);
    }

    static final class FailureNotice {
        final String route;
        final String message;
        final String lockJson;
        FailureNotice(String route,String message,String lockJson){this.route=route;this.message=message;this.lockJson=lockJson;}
    }

    /** Worker output for a failed transfer. A lock has no message, so the activity must not toast one. */
    static FailureNotice failureNotice(Exception error){
        if(error instanceof WorkspaceLocked locked){
            String raw=locked.raw==null?"":locked.raw;
            if(raw.length()>4000)raw=raw.substring(0,4000);
            return new FailureNotice(ROUTE_LOCK,null,raw);
        }
        String message=error.getMessage();
        if(message==null)message="Transfer stopped. Completed chunks are retained.";
        if(message.length()>350)message=message.substring(0,350);
        return new FailureNotice(null,message,null);
    }

    static Exception unwrap(Throwable error){
        Throwable current=error;
        int guard=0;
        while(current instanceof java.util.concurrent.ExecutionException&&current.getCause()!=null&&current.getCause()!=current&&guard++<8)current=current.getCause();
        if(current instanceof Exception exception)return exception;
        return new Exception(current==null?"Transfer stopped. Completed chunks are retained.":String.valueOf(current.getMessage()));
    }

    /** Shared by the transfer worker. A locked chunk has no toast text. Pausing still uses the pause message. */
    static FailureNotice transferFailure(Throwable error,boolean stopped){
        Exception cause=unwrap(error);
        if(cause instanceof WorkspaceLocked)return failureNotice(cause);
        if(stopped)return new FailureNotice(null,"Paused. Select the same file to resume.",null);
        return failureNotice(cause);
    }

    static final class Presentation {
        final boolean lockScreen;
        final String toast;
        Presentation(boolean lockScreen,String toast){this.lockScreen=lockScreen;this.toast=toast;}
    }

    /** Activity gate. A lock opens the full-screen explanation and never a generic toast. */
    static Presentation present(FailureNotice notice){
        if(notice!=null&&ROUTE_LOCK.equals(notice.route))return new Presentation(true,null);
        return new Presentation(false,notice==null?null:notice.message);
    }

    /** Reads and downloads stay available while uploads are paused. */
    static boolean allowsTransfer(String method,boolean locked){
        if(!locked)return true;
        return "GET".equals(method)||"HEAD".equals(method);
    }
}

final class WorkspaceLocked extends Exception {
    final WorkspaceLock lock;
    final String raw;
    WorkspaceLocked(WorkspaceLock lock){super(lock.summary());this.lock=lock;this.raw=lock.raw;}
}

final class WorkspaceLock {
    final List<Item> workspaces;
    final String raw;
    WorkspaceLock(List<Item> workspaces,String raw){this.workspaces=workspaces;this.raw=raw==null?"":raw;}
    static WorkspaceLock decode(String raw){
        if(raw==null||raw.isEmpty())return new WorkspaceLock(List.of(),"");
        return new WorkspaceLock(JsonFields.workspaces(raw),raw);
    }
    String summary(){return "Workspaces locked";}
    String issueSummary(){
        boolean cap=false,unpaid=false;
        for(Item item:workspaces){
            if("over_cap".equals(item.issue))cap=true;
            if("unpaid".equals(item.issue))unpaid=true;
        }
        if(cap&&unpaid)return "Some workspaces are over the plan cap or unpaid.";
        if(cap)return "Some workspaces are over the plan cap.";
        if(unpaid)return "Some workspaces are unpaid.";
        return "";
    }
    static final class Item {
        final String id;
        final String name;
        final String issue;
        Item(String id,String name,String issue){this.id=id;this.name=name;this.issue=issue;}
        String label(){
            String title=name==null||name.isEmpty()?id:name;
            if("over_cap".equals(issue))return title+" · over the plan cap";
            if("unpaid".equals(issue))return title+" · unpaid";
            return title;
        }
    }
}

/** Small JSON field reader so unit tests do not depend on the Android org.json stubs. */
final class JsonFields {
    private JsonFields(){}
    static String string(String json,String key){
        if(json==null||key==null)return null;
        String needle="\""+key+"\"";
        int from=0;
        while(from<json.length()){
            int at=json.indexOf(needle,from);
            if(at<0)return null;
            int colon=json.indexOf(':',at+needle.length());
            if(colon<0)return null;
            int i=colon+1;
            while(i<json.length()&&Character.isWhitespace(json.charAt(i)))i++;
            if(i>=json.length()||json.charAt(i)!='"'){from=at+needle.length();continue;}
            return readString(json,i);
        }
        return null;
    }
    static String number(String json,String key){
        if(json==null)return null;
        String needle="\""+key+"\"";
        int at=json.indexOf(needle);
        if(at<0)return null;
        int colon=json.indexOf(':',at+needle.length());
        if(colon<0)return null;
        int i=colon+1;
        while(i<json.length()&&Character.isWhitespace(json.charAt(i)))i++;
        int start=i;
        if(i<json.length()&&(json.charAt(i)=='-'||json.charAt(i)=='+'))i++;
        while(i<json.length()&&Character.isDigit(json.charAt(i)))i++;
        return i>start?json.substring(start,i):null;
    }
    static List<WorkspaceLock.Item> workspaces(String json){
        List<WorkspaceLock.Item> items=new ArrayList<>();
        if(json==null)return items;
        int key=json.indexOf("\"workspaces\"");
        if(key<0)return items;
        int start=json.indexOf('[',key);
        int end=start<0?-1:json.indexOf(']',start);
        if(start<0||end<0)return items;
        String array=json.substring(start,end+1);
        int cursor=0;
        while(cursor<array.length()){
            int open=array.indexOf('{',cursor);
            if(open<0)break;
            int close=array.indexOf('}',open);
            if(close<0)break;
            String object=array.substring(open,close+1);
            String issue=JsonFields.string(object,"issue");
            if(issue==null)issue=JsonFields.string(object,"reason");
            if(issue==null)issue=JsonFields.string(object,"status");
            items.add(new WorkspaceLock.Item(JsonFields.string(object,"id"),JsonFields.string(object,"name"),issue));
            cursor=close+1;
        }
        return items;
    }
    private static String readString(String json,int quote){
        StringBuilder out=new StringBuilder();
        for(int i=quote+1;i<json.length();i++){
            char c=json.charAt(i);
            if(c=='\\'&&i+1<json.length()){out.append(json.charAt(++i));continue;}
            if(c=='"')return out.toString();
            out.append(c);
        }
        return null;
    }
}
