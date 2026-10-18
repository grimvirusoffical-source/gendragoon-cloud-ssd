package app.gendragoon.cloudssd.mobile;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * Account-deletion bodies are copied from native/Backend at 84f6fff until PR #6 publishes fixtures.
 * Lock, workspace, merge, BYO, and ownership cases are the shared fixtures at 4dfde4b
 * ({@code fixtures/<area>/<case>.json}, shape {@code {request, response:{status, body}}}).
 * The repo-root {@code fixtures/} directory wins when this branch has it.
 */
final class BackendFixtures {
    static final String ACCOUNT_DELETION_SHA="84f6fff";
    static final String SHARED_FIXTURE_SHA="4dfde4b";

    private BackendFixtures(){}

    static String body(String name){
        String value=JsonFields.string(deletionSource(),name);
        if(value==null||value.isEmpty())throw new IllegalStateException("Missing deletion fixture "+name);
        return value;
    }

    static int responseStatus(String area,String name){
        String file=shared(area,name);
        int response=keyAt(file,"response",0);
        int status=keyAt(file,"status",response);
        int end=status;
        if(end<file.length()&&(file.charAt(end)=='-'||file.charAt(end)=='+'))end++;
        int digits=end;
        while(end<file.length()&&Character.isDigit(file.charAt(end)))end++;
        if(end==digits)throw new IllegalStateException("Missing status in "+area+"/"+name);
        return Integer.parseInt(file.substring(status,end));
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

    private static String deletionSource(){
        Path found=firstExisting(
                Path.of("fixtures","backend-http.json"),
                Path.of("native","Mobile","fixtures","backend-http.json"),
                Path.of("..","fixtures","backend-http.json"),
                Path.of("..","..","fixtures","backend-http.json"));
        try{return stripComments(read(found));}
        catch(Exception error){throw new IllegalStateException("Could not read "+found,error);}
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

    private static String stripComments(String raw){
        StringBuilder out=new StringBuilder();
        for(String line:raw.split("\n",-1)){
            if(!line.trim().startsWith("//"))out.append(line).append('\n');
        }
        return out.toString();
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
}
