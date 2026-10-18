package app.gendragoon.cloudssd.mobile;

import java.util.List;
import java.util.function.BiConsumer;

/** Workspace names and selection for the lock screen. Pure so it runs in unit tests. */
final class WorkspaceNames {
    private WorkspaceNames(){}
    static String selectionKey(String uid){return "workspace:"+uid;}
    /** The free slot's name comes from the server {@code isFree}, not a hard-coded "Free". */
    static String freeName(String serverName,Boolean isFree){
        if(Boolean.TRUE.equals(isFree))return WorkspacePrice.FREE;
        return serverName==null||serverName.trim().isEmpty()?"Workspace":serverName;
    }
    static String label(List<WorkspaceLock.Item> known,String id){
        if(known!=null)for(WorkspaceLock.Item item:known)if(id!=null&&id.equals(item.id))return item.label();
        return "this workspace";
    }
    /** Saves the new selection so the app does not relock on launch. Returns the id to open. */
    static String switchTo(BiConsumer<String,String> save,String uid,String id){
        String target=id==null||id.isEmpty()?"free":id;
        save.accept(selectionKey(uid),target);
        return target;
    }
}
