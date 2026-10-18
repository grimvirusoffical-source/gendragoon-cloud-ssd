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
        String friendly=ByoMessages.friendly(status,message);
        if(friendly!=null)message=friendly;
        else if(message==null||message.isEmpty()||CODE_LOCK.equals(message))message="Cloud request failed (HTTP "+status+").";
        return new Route(Destination.GENERIC_ERROR,message,null,body,status,verb);
    }

    static WorkspaceLock workspaceLock(int status,String body){
        if(status!=423||!CODE_LOCK.equals(JsonFields.string(body,"error")))return null;
        return WorkspaceLock.fromLockBody(body==null?"":body);
    }

    static boolean shouldToast(Exception error){return !(error instanceof WorkspaceLocked)&&error.getMessage()!=null;}

    /**
     * Firebase ID tokens carry {@code auth_time} in seconds. A silent refresh updates {@code iat}
     * and does not make an older sign-in fresh. Missing or older than five minutes is not fresh.
     */
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

/**
 * Workspace price copy. Off until pricing labels ship. {@code isFree:true} shows "Free".
 * {@code grandfathered:true} shows "Included" (those rows are {@code isFree:false} and
 * {@code monthlyPriceCents:0}). Every other row shows {@code monthlyPriceCents}. Zero is not a
 * price, so the label is never {@code $0.00/mo}. The client does not count workspaces.
 */
final class WorkspacePrice {
    static final boolean ENABLED=false;
    static final String FREE="Free";
    static final String INCLUDED="Included";
    private WorkspacePrice(){}
    /** Dollars from server cents. {@code null} for a missing or zero amount. */
    static String formatCents(Integer cents){
        if(cents==null||cents<=0)return null;
        int dollars=cents/100,remainder=cents%100;
        if(remainder==0)return "$"+dollars+"/mo";
        return String.format(java.util.Locale.ROOT,"$%d.%02d/mo",dollars,remainder);
    }
    static String priceLabel(Boolean isFree,boolean grandfathered,Integer monthlyPriceCents){
        if(Boolean.TRUE.equals(isFree))return FREE;
        if(grandfathered)return INCLUDED;
        return formatCents(monthlyPriceCents);
    }
    static String pickerText(String workspaceJson){return pickerText(workspaceJson,ENABLED);}
    static String pickerText(String workspaceJson,boolean enabled){
        Integer cents=null;
        String raw=JsonFields.number(workspaceJson,"monthlyPriceCents");
        if(raw!=null){try{cents=Integer.parseInt(raw);}catch(NumberFormatException ignored){cents=null;}}
        boolean grandfathered=Boolean.TRUE.equals(JsonFields.bool(workspaceJson,"grandfathered"));
        return pickerText(JsonFields.string(workspaceJson,"name"),JsonFields.bool(workspaceJson,"isFree"),grandfathered,cents,enabled);
    }
    static String pickerText(String name,Boolean isFree,boolean grandfathered,Integer monthlyPriceCents,boolean enabled){
        String title=name==null||name.isEmpty()?"Workspace":name;
        if(!enabled)return title;
        String price=priceLabel(isFree,grandfathered,monthlyPriceCents);
        return price==null?title:title+" · "+price;
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
    final int overBy;
    final List<String> unpaidIds;
    WorkspaceLock(List<Item> workspaces,String raw){this(workspaces,raw,0,List.of());}
    WorkspaceLock(List<Item> workspaces,String raw,int overBy,List<String> unpaidIds){
        this.workspaces=workspaces==null?List.of():workspaces;this.raw=raw==null?"":raw;this.overBy=Math.max(0,overBy);this.unpaidIds=unpaidIds==null?List.of():unpaidIds;
    }
    static WorkspaceLock decode(String raw){
        if(raw==null||raw.isEmpty())return new WorkspaceLock(List.of(),"");
        return fromLockBody(raw);
    }
    /** PR #5 lock body. Names come from the workspace list, not from this JSON. */
    static WorkspaceLock fromLockBody(String body){
        if(body!=null&&body.contains("\"unpaidWorkspaceIds\"")){
            String count=JsonFields.number(body,"overBy");
            int overBy=0;
            if(count!=null)try{overBy=Integer.parseInt(count);}catch(NumberFormatException ignored){overBy=0;}
            List<String> ids=JsonFields.stringList(body,"unpaidWorkspaceIds");
            List<Item> items=new ArrayList<>();
            for(String id:ids)items.add(new Item(id,null,"unpaid"));
            return new WorkspaceLock(items,body,overBy,ids);
        }
        return new WorkspaceLock(JsonFields.workspaces(body),body,0,List.of());
    }
    /** Replace id-only rows with names from the cached workspace list. overBy makes every cached workspace actionable. */
    WorkspaceLock named(List<Item> known){
        if(known==null)known=List.of();
        if(overBy<=0&&unpaidIds.isEmpty())return this;
        List<Item> items=new ArrayList<>();
        java.util.Set<String> seen=new java.util.HashSet<>();
        if(overBy>0){
            for(Item item:known){
                if(item==null||item.id==null)continue;
                seen.add(item.id);
                items.add(new Item(item.id,item.name,unpaidIds.contains(item.id)?"unpaid":null));
            }
        }
        for(String id:unpaidIds){
            if(id==null||!seen.add(id))continue;
            String name=null;
            for(Item item:known)if(item!=null&&id.equals(item.id))name=item.name;
            items.add(new Item(id,name,"unpaid"));
        }
        return new WorkspaceLock(items,raw,overBy,unpaidIds);
    }
    static final String ACTION_DELETE="Delete";
    static final String ACTION_MERGE="Merge";
    static final String ACTION_DOWNLOAD="Download files";
    static final String DETAIL_MERGE="A merge is already running. Wait until it finishes. Your files stay available to download.";
    static final String DETAIL_SCOPE="This action is not available for the current workspace scope. Your files stay available to download.";
    static final String DETAIL_PAY="Pay to restore this plan. Your files stay available to download.";
    String reasonText(){String reason=JsonFields.string(raw,"reason");return reason==null?"":reason;}
    /** {@code lapsed} and {@code over_cap_and_lapsed} ask the user to pay. Delete and Merge stay hidden. */
    boolean requiresPayment(){
        String reason=reasonText();
        return "lapsed".equals(reason)||"over_cap_and_lapsed".equals(reason);
    }
    /** Clear copy for reasons that do not include a workspace list. */
    String detailText(){
        String reason=reasonText();
        if("merge_in_progress".equals(reason))return DETAIL_MERGE;
        if("scope_unavailable".equals(reason))return DETAIL_SCOPE;
        if(requiresPayment())return DETAIL_PAY;
        return "";
    }
    String overByText(){return "Over by "+overBy;}
    String chooseMessage(){return overBy>0?"Choose "+overBy+" workspaces to remove.":"";}
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
    static Boolean bool(String json,String key){
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
            if(json.startsWith("true",i))return Boolean.TRUE;
            if(json.startsWith("false",i))return Boolean.FALSE;
            from=at+needle.length();
        }
        return null;
    }
    static List<String> stringList(String json,String key){
        List<String> values=new ArrayList<>();
        if(json==null||key==null)return values;
        int keyAt=json.indexOf("\""+key+"\"");
        if(keyAt<0)return values;
        int start=json.indexOf('[',keyAt);
        int end=start<0?-1:json.indexOf(']',start);
        if(start<0||end<0)return values;
        String array=json.substring(start,end+1);
        int cursor=0;
        while(cursor<array.length()){
            int quote=array.indexOf('"',cursor);
            if(quote<0)break;
            String value=readString(array,quote);
            if(value==null)break;
            values.add(value);
            cursor=quote+value.length()+2;
        }
        return values;
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

/** Friendly copy for bring-your-own storage. The raw provider code is never shown. */
final class ByoMessages {
    static final String COMING_SOON="Coming soon";
    static final String UNSUPPORTED="That storage provider isn't available yet. S3-compatible storage is supported.";
    static final String PRESIGNED_URL_REQUIRED="A presigned URL is required to verify this storage.";
    static final String CHALLENGE_EXPIRED="This storage check expired. Start the check again.";
    static final String HOST_MISMATCH="The presigned URL does not match the storage you registered.";
    static final String CHALLENGE_MISMATCH="The storage check did not match. Start the check again.";
    static final String CHALLENGE_USED="This storage check was already used. Start a new check.";
    private ByoMessages(){}
    static String friendly(int status,String error){
        if(status==422&&"byo_provider_unsupported".equals(error))return UNSUPPORTED;
        if(status==400&&"presigned_url_required".equals(error))return PRESIGNED_URL_REQUIRED;
        if(status==400&&"BYO_CHALLENGE_EXPIRED".equals(error))return CHALLENGE_EXPIRED;
        if(status==400&&"BYO_ENDPOINT_HOST_MISMATCH".equals(error))return HOST_MISMATCH;
        if(status==400&&"BYO_CHALLENGE_MISMATCH".equals(error))return CHALLENGE_MISMATCH;
        if(status==400&&"BYO_CHALLENGE_USED".equals(error))return CHALLENGE_USED;
        return null;
    }
    static boolean comingSoon(String provider){
        if(provider==null)return false;
        String name=provider.toLowerCase(java.util.Locale.ROOT);
        return "sftp".equals(name)||"azure".equals(name)||"webdav".equals(name);
    }
}

/**
 * Bring-your-own storage ships only as the server register, challenge, and verify flow.
 * The on-device SigV4 proof is not green, so the settings entry stays hidden.
 * There is no key-only fallback.
 */
final class ByoFeature {
    static final boolean SERVER_FLOW_ENABLED=false;
    private ByoFeature(){}
    static boolean showInSettings(){return SERVER_FLOW_ENABLED;}
}

/** Re-sign-in must be the same Google account that started deletion. */
final class AccountMatch {
    private AccountMatch(){}
    static boolean same(String expectedUid,String expectedEmail,String actualUid,String actualEmail){
        if(expectedUid==null||actualUid==null||expectedUid.isEmpty()||!expectedUid.equals(actualUid))return false;
        if(expectedEmail==null||expectedEmail.isEmpty())return true;
        return actualEmail!=null&&expectedEmail.equalsIgnoreCase(actualEmail);
    }
}
