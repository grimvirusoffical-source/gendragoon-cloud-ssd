package app.gendragoon.cloudssd.mobile;

import android.content.Context;
import android.database.Cursor;
import android.database.CursorWindow;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.*;
import android.provider.DocumentsContract;
import android.provider.DocumentsProvider;
import java.io.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/** Test APK UID owns public fixtures only. No provider is included in release. */
public final class FixtureDocumentsProvider extends DocumentsProvider {
    static final String AUTHORITY="app.gendragoon.cloudssd.mobile.acceptance.documents";
    private static final String DIR=DocumentsContract.Document.MIME_TYPE_DIR;
    private static final Map<String,Tree> trees=new ConcurrentHashMap<>();
    private static final String[] DOCUMENT={DocumentsContract.Document.COLUMN_DOCUMENT_ID,DocumentsContract.Document.COLUMN_DISPLAY_NAME,DocumentsContract.Document.COLUMN_MIME_TYPE,DocumentsContract.Document.COLUMN_SIZE,DocumentsContract.Document.COLUMN_FLAGS,"owner_uid","caller_uid"};
    private static final class Entry {
        final String id,name,type;final File bytes;
        Entry(String id,String name,String type,File bytes){this.id=id;this.name=name;this.type=type;this.bytes=bytes;}
    }
    private static final class Tree {
        final String nonce,mode;final File root;
        final Map<String,Entry> entries=new LinkedHashMap<>();
        final AtomicInteger initialWindows=new AtomicInteger(),initialRows=new AtomicInteger(),laterWindows=new AtomicInteger(),laterThrows=new AtomicInteger(),laterStops=new AtomicInteger();
        final AtomicInteger laterPosition=new AtomicInteger(-1),advertisedCount=new AtomicInteger(-1),changedCount=new AtomicInteger(-1),physicalRows=new AtomicInteger(-1);
        Tree(String nonce,String mode,File root){this.nonce=nonce;this.mode=mode;this.root=root;}
        void directory(String key,String name){entries.put(key,new Entry(nonce+":"+key,name,DIR,null));}
        void file(String key,String name,int size)throws IOException{
            File target=new File(root,key);byte[] bytes=new byte[size];
            for(int n=0;n<size;n++)bytes[n]=(byte)((n*73+n/251)&255);
            try(FileOutputStream output=new FileOutputStream(target)){output.write(bytes);output.getFD().sync();}
            entries.put(key,new Entry(nonce+":"+key,name,"application/octet-stream",target));
        }
    }
    static Uri create(Context context,String mode)throws Exception{
        Set<String> modes=Set.of("folder","single","empty","query-failure","cursor-failure","cursor-stop","count-mismatch","changed-count","negative-count","over-budget","null","loading","wrong-loading","null-loading","wrong-total","null-total","negative-total","error","total","collision","unicode-collision","duplicate-id","bad-name","depth","read-failure","output","output-failure","output-partial");
        if(!modes.contains(mode))throw new IOException("Unknown owned fixture case.");
        String nonce=UUID.randomUUID().toString();File root=new File(context.getFilesDir(),"documents-"+nonce);if(!root.mkdir())throw new IOException("Fixture directory unavailable.");
        Tree tree=new Tree(nonce,mode,root);tree.directory("root","Selected folder");tree.directory("nested","Nested");tree.directory("empty","Empty folder");
        tree.file("first","binary.bin",8192);tree.file("unicode","雪-é.bin",123);tree.file("single","plain.bin",150*1024);
        tree.file("collision","BINARY.BIN",17);tree.file("composed","é.bin",3);tree.file("decomposed","e\u0301.bin",3);tree.file("bad","../escape",9);tree.file("output","export.bin",0);
        trees.put(nonce,tree);
        boolean single=mode.equals("single")||mode.equals("read-failure")||mode.startsWith("output");
        return single?DocumentsContract.buildDocumentUri(AUTHORITY,nonce+":"+(mode.startsWith("output")?"output":"single")):DocumentsContract.buildTreeDocumentUri(AUTHORITY,nonce+":root");
    }
    private static Tree tree(String id)throws FileNotFoundException{
        int split=id.indexOf(':');Tree tree=split<0?null:trees.get(id.substring(0,split));if(tree==null)throw new FileNotFoundException("Unknown fixture document.");return tree;
    }
    private static Entry entry(Tree tree,String id)throws FileNotFoundException{
        String key=id.substring(id.indexOf(':')+1);
        if(tree.mode.equals("depth")&&(key.equals("root")||key.startsWith("level-")))return new Entry(id,key,DIR,null);
        Entry row=tree.entries.get(key);if(row==null)throw new FileNotFoundException("Unknown fixture entry.");return row;
    }
    private static void row(MatrixCursor cursor,String[] projection,Entry entry){
        Object[] values=new Object[projection.length];Tree diagnostics;
        try{diagnostics=tree(entry.id);}catch(FileNotFoundException error){throw new IllegalStateException(error);}
        for(int n=0;n<projection.length;n++)values[n]=switch(projection[n]){
            case DocumentsContract.Document.COLUMN_DOCUMENT_ID->entry.id;
            case DocumentsContract.Document.COLUMN_DISPLAY_NAME->entry.name;
            case DocumentsContract.Document.COLUMN_MIME_TYPE->entry.type;
            case DocumentsContract.Document.COLUMN_SIZE->entry.bytes==null?0L:entry.bytes.length();
            case DocumentsContract.Document.COLUMN_FLAGS->entry.bytes==null?0:DocumentsContract.Document.FLAG_SUPPORTS_WRITE;
            case "owner_uid"->android.os.Process.myUid();
            case "caller_uid"->Binder.getCallingUid();
            case "initial_windows"->diagnostics.initialWindows.get();
            case "initial_rows"->diagnostics.initialRows.get();
            case "later_windows"->diagnostics.laterWindows.get();
            case "later_position"->diagnostics.laterPosition.get();
            case "later_throws"->diagnostics.laterThrows.get();
            case "later_stops"->diagnostics.laterStops.get();
            case "advertised_count"->diagnostics.advertisedCount.get();
            case "changed_count"->diagnostics.changedCount.get();
            case "physical_rows"->diagnostics.physicalRows.get();
            default->null;
        };
        cursor.addRow(values);
    }
    @Override public boolean onCreate(){return true;}
    @Override public Cursor queryRoots(String[] projection){return new MatrixCursor(projection==null?new String[]{DocumentsContract.Root.COLUMN_ROOT_ID,DocumentsContract.Root.COLUMN_DOCUMENT_ID,DocumentsContract.Root.COLUMN_TITLE,DocumentsContract.Root.COLUMN_FLAGS}:projection);}
    @Override public Cursor queryDocument(String id,String[] projection)throws FileNotFoundException{
        Tree tree=tree(id);String[] columns=projection==null?DOCUMENT:projection;MatrixCursor cursor=new MatrixCursor(columns);row(cursor,columns,entry(tree,id));return cursor;
    }
    @Override public Cursor queryChildDocuments(String id,String[] projection,String sort)throws FileNotFoundException{
        Tree tree=tree(id);String[] columns=projection==null?DOCUMENT:projection;
        if(tree.mode.equals("query-failure"))throw new IllegalStateException("Owned child query failure.");
        if(tree.mode.equals("null"))return null;
        boolean controlledWindow=Set.of("cursor-failure","cursor-stop","count-mismatch","changed-count","negative-count","over-budget").contains(tree.mode);
        MatrixCursor cursor=controlledWindow?new MatrixCursor(columns){
            @Override public int getCount(){
                int actual=super.getCount();tree.physicalRows.set(actual);
                if(tree.mode.equals("negative-count"))return -1;
                if(tree.mode.equals("over-budget"))return 100001;
                if(tree.mode.equals("count-mismatch"))return actual+1;
                if(tree.mode.equals("changed-count")&&tree.initialWindows.get()>0){tree.changedCount.set(actual-1);return actual-1;}
                return actual;
            }
            @Override public boolean onMove(int old,int next){
                if(next>=1&&tree.initialWindows.get()>0){
                    tree.laterWindows.incrementAndGet();tree.laterPosition.set(next);
                    if(tree.mode.equals("cursor-failure")){tree.laterThrows.incrementAndGet();throw new IllegalStateException("Owned later IPC-window failure.");}
                    if(tree.mode.equals("cursor-stop")){tree.laterStops.incrementAndGet();return false;}
                }
                if(next>=super.getCount()){tree.laterStops.incrementAndGet();return false;}
                return super.onMove(old,next);
            }
            @Override public void fillWindow(int position,CursorWindow window){
                window.clear();window.setStartPosition(position);
                if(!window.setNumColumns(getColumnCount())||!window.allocRow())throw new IllegalStateException("Owned initial IPC window unavailable.");
                // Exactly one complete row, not super.fillWindow's eager iteration.
                // The app must request a later IPC window before either failure fires.
                for(int column=0;column<getColumnCount();column++){
                    boolean written=switch(getType(column)){
                        case Cursor.FIELD_TYPE_NULL->window.putNull(position,column);
                        case Cursor.FIELD_TYPE_INTEGER->window.putLong(getLong(column),position,column);
                        case Cursor.FIELD_TYPE_FLOAT->window.putDouble(getDouble(column),position,column);
                        case Cursor.FIELD_TYPE_BLOB->window.putBlob(getBlob(column),position,column);
                        default->window.putString(getString(column),position,column);
                    };
                    if(!written)throw new IllegalStateException("Owned IPC row does not fit.");
                }
                if(position==0){tree.initialWindows.incrementAndGet();tree.initialRows.set(window.getNumRows());}
            }
        }:new MatrixCursor(columns);
        String key=id.substring(id.indexOf(':')+1);
        if(tree.mode.equals("depth")){
            int level=key.equals("root")?0:Integer.parseInt(key.substring(6));
            row(cursor,columns,new Entry(tree.nonce+":level-"+(level+1),"level-"+(level+1),DIR,null));
        }else if(!tree.mode.equals("empty")){
            if(key.equals("root")){
                for(String child:tree.mode.equals("collision")?new String[]{"first","collision"}:tree.mode.equals("unicode-collision")?new String[]{"composed","decomposed"}:tree.mode.equals("duplicate-id")?new String[]{"first","first"}:tree.mode.equals("bad-name")?new String[]{"bad"}:new String[]{"first","nested","empty"})row(cursor,columns,tree.entries.get(child));
            }else if(key.equals("nested"))row(cursor,columns,tree.entries.get("unicode"));
        }
        tree.advertisedCount.set(cursor.getCount());
        Bundle extras=new Bundle();extras.putBoolean(DocumentsContract.EXTRA_LOADING,false);
        if(tree.mode.equals("loading"))extras.putBoolean(DocumentsContract.EXTRA_LOADING,true);
        if(tree.mode.equals("wrong-loading"))extras.putString(DocumentsContract.EXTRA_LOADING,"false");
        if(tree.mode.equals("null-loading"))extras.putString(DocumentsContract.EXTRA_LOADING,null);
        if(tree.mode.equals("total"))extras.putInt(android.content.ContentResolver.EXTRA_TOTAL_COUNT,cursor.getCount()+1);
        if(tree.mode.equals("wrong-total"))extras.putLong(android.content.ContentResolver.EXTRA_TOTAL_COUNT,cursor.getCount());
        if(tree.mode.equals("null-total"))extras.putString(android.content.ContentResolver.EXTRA_TOTAL_COUNT,null);
        if(tree.mode.equals("negative-total"))extras.putInt(android.content.ContentResolver.EXTRA_TOTAL_COUNT,-2);
        if(tree.mode.equals("error"))extras.putString(DocumentsContract.EXTRA_ERROR,"Owned provider failure.");
        cursor.setExtras(extras);return cursor;
    }
    @Override public boolean isChildDocument(String parent,String child){
        try{
            Tree tree=tree(parent);if(tree!=tree(child)||parent.equals(child))return false;
            String p=parent.substring(parent.indexOf(':')+1),c=child.substring(child.indexOf(':')+1);
            if(p.equals("root"))return true;
            if(tree.mode.equals("depth")&&p.startsWith("level-")&&c.startsWith("level-"))return Integer.parseInt(c.substring(6))>Integer.parseInt(p.substring(6));
            return p.equals("nested")&&c.equals("unicode");
        }catch(Exception ignored){return false;}
    }
    @Override public ParcelFileDescriptor openDocument(String id,String mode,CancellationSignal signal)throws FileNotFoundException{
        Tree tree=tree(id);Entry entry=entry(tree,id);if(entry.bytes==null)throw new FileNotFoundException("A directory is not a stream.");
        if(mode.contains("w")){
            if(tree.mode.equals("output-failure"))throw new FileNotFoundException("Owned output refusal.");
            if(tree.mode.equals("output-partial")){
                try{
                    ParcelFileDescriptor[] pipe=ParcelFileDescriptor.createReliablePipe();
                    Thread reader=new Thread(()->{try(InputStream input=new ParcelFileDescriptor.AutoCloseInputStream(pipe[0])){byte[] bytes=new byte[32];input.read(bytes);pipe[0].closeWithError("Owned partial output failure.");}catch(IOException ignored){/* The sender must observe the broken fixture destination. */}},"GenDragoon-fixture-output");reader.setDaemon(true);reader.start();return pipe[1];
                }catch(IOException error){throw new FileNotFoundException("Owned output pipe unavailable.");}
            }
            return ParcelFileDescriptor.open(entry.bytes,ParcelFileDescriptor.MODE_CREATE|ParcelFileDescriptor.MODE_TRUNCATE|ParcelFileDescriptor.MODE_WRITE_ONLY);
        }
        if(tree.mode.equals("read-failure"))throw new FileNotFoundException("Owned input refusal.");
        return ParcelFileDescriptor.open(entry.bytes,ParcelFileDescriptor.MODE_READ_ONLY);
    }
}
