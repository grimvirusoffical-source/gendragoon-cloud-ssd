package app.gendragoon.cloudssd.mobile;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * Account-deletion fixtures are {@code fixtures/account-deletion} at fff0a84.
 * Support-request responses are {@code fixtures/support} at d9888be. The client path is pinned
 * and sends no body; those files still record {@code POST /v2/support/deletion-request}.
 * Workspace price fixtures are the {@code workspaces/} files from PR #5 at 4c3dd13,
 * including {@code grandfathered-plus-new}. {@code list.json}, {@code create.json}, and
 * {@code cap-reached.json} stay on the shared fixtures at da39276.
 * Key-envelope fixtures are {@code fixtures/key-envelope} at ee4f76f.
 * Lock, workspace, merge, BYO, and ownership cases stay on the shared fixtures at da39276.
 * The repo-root {@code fixtures/} directory wins when this branch has it.
 * {@code singular-path.json} is JSON. A non-JSON body in a test is synthetic.
 */
final class BackendFixtures {
    static final String ACCOUNT_DELETION_SHA="fff0a84";
    static final String SUPPORT_FIXTURE_SHA="d9888be";
    static final String WORKSPACE_PRICE_SHA="4c3dd13";
    static final String KEY_ENVELOPE_SHA="ee4f76f";
    static final String SHARED_FIXTURE_SHA="da39276";

    private BackendFixtures(){}

    static String body(String name){
        String file=switch(name){
            case "delete202"->"accepted";
            case "accountDeleted410"->"account-deleted";
            case "reauth401"->"reauth-required";
            case "invalidToken401"->"invalid-token";
            case "pollQueued"->"status-queued";
            case "pollRunning"->"status-running";
            case "pollDone"->"status-done";
            case "pollFailed"->"status-failed";
            case "pollNotFound"->"expired-token";
            default->name;
        };
        return responseBody("account-deletion",file);
    }

    static int responseStatus(String area,String name){
        String file=withoutResponseBody(shared(area,name));
        int response=keyAt(file,"response",0);
        int status=keyAt(file,"status",response);
        int end=status;
        if(end<file.length()&&(file.charAt(end)=='-'||file.charAt(end)=='+'))end++;
        int digits=end;
        while(end<file.length()&&Character.isDigit(file.charAt(end)))end++;
        if(end==digits)throw new IllegalStateException("Missing status in "+area+"/"+name);
        return Integer.parseInt(file.substring(status,end));
    }

    /**
     * The export sorts keys, so {@code response.body} comes before {@code response.status}. A
     * status poll body has its own {@code "status":"done"}; drop the body so the HTTP status is read.
     */
    private static String withoutResponseBody(String file){
        int response=keyAt(file,"response",0);
        int at=file.indexOf("\"body\"",response);
        if(at<0)return file;
        int value=keyAt(file,"body",response);
        return file.substring(0,value)+"null"+file.substring(rawValueEnd(file,value));
    }

    /** End index of a JSON value in the source text. String length is the encoded length, not the decoded text. */
    private static int rawValueEnd(String json,int start){
        char first=json.charAt(start);
        if(first=='"'){
            for(int i=start+1;i<json.length();i++){
                char c=json.charAt(i);
                if(c=='\\'){i++;continue;}
                if(c=='"')return i+1;
            }
            throw new IllegalStateException("Unclosed JSON string");
        }
        return start+jsonValue(json,start).length();
    }

    static String responseBody(String area,String name){
        String file=shared(area,name);
        int response=keyAt(file,"response",0);
        return jsonValue(file,keyAt(file,"body",response));
    }

    static String requestPath(String area,String name){
        String file=shared(area,name);
        int request=keyAt(file,"request",0);
        String path=JsonFields.string(file.substring(request),"path");
        if(path==null)throw new IllegalStateException("Missing path in "+area+"/"+name);
        return path;
    }

    static String requestBody(String area,String name){
        String file=shared(area,name);
        int request=keyAt(file,"request",0);
        String value=jsonValue(file,keyAt(file,"body",request));
        return "null".equals(value)?"":value;
    }

    /** Named rows from a 4c3dd13 workspace fixture: each {@code workspaces[]} item, or {@code project}. */
    static List<String> pricedWorkspaces(String name){
        String body=responseBody("workspaces",name);
        List<String> rows=objectsUnder(body,"workspaces");
        if(!rows.isEmpty())return rows;
        String project=objectUnder(body,"project");
        return project==null?List.of():List.of(project);
    }

    private static List<String> objectsUnder(String json,String key){
        int at=json.indexOf("\""+key+"\"");
        if(at<0)return List.of();
        int start=json.indexOf('[',at);
        if(start<0)return List.of();
        String array=jsonValue(json,start);
        List<String> rows=new ArrayList<>();
        int cursor=0;
        while(cursor<array.length()){
            int open=array.indexOf('{',cursor);
            if(open<0)break;
            String object=jsonValue(array,open);
            rows.add(object);
            cursor=open+object.length();
        }
        return rows;
    }

    private static String objectUnder(String json,String key){
        int at=json.indexOf("\""+key+"\"");
        if(at<0)return null;
        int start=json.indexOf('{',at);
        if(start<0)return null;
        return jsonValue(json,start);
    }

    static List<WorkspaceLock.Item> listedWorkspaces(){
        String body=responseBody("workspaces","list");
        int key=body.indexOf("\"workspaces\"");
        if(key<0)return List.of();
        int start=body.indexOf('[',key);
        String array=jsonValue(body,start);
        List<WorkspaceLock.Item> items=new ArrayList<>();
        int cursor=0;
        while(cursor<array.length()){
            int open=array.indexOf('{',cursor);
            if(open<0)break;
            String object=jsonValue(array,open);
            items.add(new WorkspaceLock.Item(JsonFields.string(object,"id"),JsonFields.string(object,"name"),null));
            cursor=open+object.length();
        }
        return items;
    }

    private static String shared(String area,String name){
        String relative=area+"/"+name+".json";
        Path found=firstExisting(
                Path.of("fixtures",relative),
                Path.of("..","..","..","fixtures",relative),
                Path.of("native","Mobile","fixtures","shared",relative),
                Path.of("..","fixtures","shared",relative),
                Path.of("src","test","resources","fixtures",relative));
        try{return read(found);}
        catch(Exception error){throw new IllegalStateException("Could not read "+found,error);}
    }

    private static Path firstExisting(Path... candidates){
        for(Path candidate:candidates)if(Files.isRegularFile(candidate))return candidate;
        throw new IllegalStateException("Fixture was not found");
    }

    private static String read(Path found) throws java.io.IOException {
        return new String(Files.readAllBytes(found),StandardCharsets.UTF_8);
    }

    private static int keyAt(String json,String key,int from){
        int at=json.indexOf("\""+key+"\"",Math.max(0,from));
        if(at<0)throw new IllegalStateException("Missing "+key);
        int colon=json.indexOf(':',at);
        int i=colon+1;
        while(i<json.length()&&Character.isWhitespace(json.charAt(i)))i++;
        return i;
    }

    private static String jsonValue(String json,int start){
        if(start>=json.length())throw new IllegalStateException("Missing JSON value");
        char first=json.charAt(start);
        if(first=='"')return readJsonString(json,start);
        if(first!='{'&&first!='['){
            int end=start;
            while(end<json.length()&&",}\n\r".indexOf(json.charAt(end))<0)end++;
            return json.substring(start,end).trim();
        }
        char close=first=='{'?'}':']';
        boolean string=false;
        int depth=0;
        for(int i=start;i<json.length();i++){
            char c=json.charAt(i);
            if(string){
                if(c=='\\'){i++;continue;}
                if(c=='"')string=false;
                continue;
            }
            if(c=='"'){string=true;continue;}
            if(c==first)depth++;
            else if(c==close&&--depth==0)return json.substring(start,i+1);
        }
        throw new IllegalStateException("Unclosed JSON value");
    }

    /** Decodes a JSON string, including HTML error pages stored as strings. */
    private static String readJsonString(String json,int start){
        StringBuilder out=new StringBuilder();
        for(int i=start+1;i<json.length();i++){
            char c=json.charAt(i);
            if(c=='\\'){
                if(i+1>=json.length())break;
                char next=json.charAt(++i);
                if(next=='n')out.append('\n');
                else if(next=='r')out.append('\r');
                else if(next=='t')out.append('\t');
                else if(next=='u'&&i+4<json.length()){
                    out.append((char)Integer.parseInt(json.substring(i+1,i+5),16));
                    i+=4;
                }else out.append(next);
                continue;
            }
            if(c=='"')return out.toString();
            out.append(c);
        }
        throw new IllegalStateException("Unclosed JSON string");
    }
}
