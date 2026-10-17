package app.gendragoon.cloudssd.mobile;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.*;

/** Portable, streamed folder snapshots selected through Android's document tree picker. */
final class SelectionArchive {
    interface Cancellation { void check() throws Exception; }
    static final int MAX_ENTRIES = 100_000;
    static final class Entry {
        final Uri uri; final String path; final boolean directory; final long size; final String sha256;
        Entry(Uri uri, String path, boolean directory, long size, String sha256) {
            this.uri=uri; this.path=path; this.directory=directory; this.size=size; this.sha256=sha256;
        }
        String fingerprint(){return (directory?"d":"f")+":"+size+":"+sha256;}
    }
    final Uri root; final File archive; final String name; final Map<String,Entry> entries;
    private SelectionArchive(Uri root, File archive, String name, Map<String,Entry> entries){this.root=root;this.archive=archive;this.name=name;this.entries=entries;}
    static boolean isApplication(String name) {
        String lower=name.toLowerCase(Locale.ROOT);
        for(String extension:List.of(".app",".app.zip",".dmg",".pkg",".exe",".msi",".msix",".appimage",".deb",".rpm",".apk",".aab",".ipa",".gdapp.zip"))if(lower.endsWith(extension))return true;
        return false;
    }
    static String safeName(String value)throws IOException{
        if(value==null||value.isEmpty()||value.equals(".")||value.equals("..")||value.indexOf('/')>=0||value.indexOf('\\')>=0||value.indexOf(':')>=0||value.indexOf('\0')>=0)throw new IOException("A selected file has an unsafe portable name.");
        return value;
    }
    private static String hex(byte[] value){StringBuilder output=new StringBuilder();for(byte b:value)output.append(String.format(Locale.ROOT,"%02x",b&255));return output.toString();}
    static String digest(InputStream input, Cancellation cancellation)throws Exception{
        if(input==null)throw new IOException("The selected document is not readable.");
        try(InputStream in=input){MessageDigest hash=MessageDigest.getInstance("SHA-256");byte[] buffer=new byte[64*1024];int count;while((count=in.read(buffer))!=-1){cancellation.check();hash.update(buffer,0,count);}return hex(hash.digest());}
    }
    private static Entry metadata(ContentResolver resolver,Uri uri,String parent,Cancellation cancellation)throws Exception{
        cancellation.check();String[] columns={DocumentsContract.Document.COLUMN_DISPLAY_NAME,DocumentsContract.Document.COLUMN_MIME_TYPE,DocumentsContract.Document.COLUMN_SIZE};
        try(Cursor cursor=resolver.query(uri,columns,null,null,null)){
            if(cursor==null||!cursor.moveToFirst())throw new IOException("A selected document disappeared.");
            String name=safeName(cursor.getString(0));boolean directory=DocumentsContract.Document.MIME_TYPE_DIR.equals(cursor.getString(1));
            if(!directory&&cursor.isNull(2))throw new IOException("This provider does not report file sizes. Save the document locally first.");
            long size=directory?0:cursor.getLong(2);if(size<0)throw new IOException("Invalid document size.");
            return new Entry(uri,parent+name,directory,size,directory?"":digest(resolver.openInputStream(uri),cancellation));
        }
    }
    static Map<String,Entry> snapshot(Context context,Uri selected,Cancellation cancellation)throws Exception{
        ContentResolver resolver=context.getContentResolver();
        if(!"content".equals(selected.getScheme()))throw new IOException("Choose content using the system file picker.");
        Uri root=DocumentsContract.isTreeUri(selected)?DocumentsContract.buildDocumentUriUsingTree(selected,DocumentsContract.getTreeDocumentId(selected)):selected;
        Map<String,Entry> entries=new TreeMap<>();Set<String> documentIds=new HashSet<>(),folded=new HashSet<>();
        Deque<Entry> pending=new ArrayDeque<>();pending.add(metadata(resolver,root,"",cancellation));
        while(!pending.isEmpty()){
            cancellation.check();Entry entry=pending.removeFirst();String normalized=java.text.Normalizer.normalize(entry.path,java.text.Normalizer.Form.NFC).toLowerCase(Locale.ROOT);
            if(entries.size()>=MAX_ENTRIES||entry.path.split("/").length>64||!folded.add(normalized)||!documentIds.add(entry.uri.toString()))throw new IOException("Folder contains a cycle, duplicate names or too many entries.");
            entries.put(entry.path,entry);
            if(entry.directory){
                Uri children=DocumentsContract.buildChildDocumentsUriUsingTree(root,DocumentsContract.getDocumentId(entry.uri));
                try(Cursor cursor=resolver.query(children,new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID},null,null,null)){
                    if(cursor==null)throw new IOException("A folder cannot be listed.");
                    while(cursor.moveToNext()){
                        if(pending.size()+entries.size()>=MAX_ENTRIES)throw new IOException("Folder has too many entries.");
                        Uri child=DocumentsContract.buildDocumentUriUsingTree(root,cursor.getString(0));pending.add(metadata(resolver,child,entry.path+"/",cancellation));
                    }
                }
            }
        }
        return entries;
    }
    static SelectionArchive create(Context context,Uri selected,long maximumBytes,Cancellation cancellation)throws Exception{
        Map<String,Entry> entries=snapshot(context,selected,cancellation);Entry root=entries.values().iterator().next();
        long total=0;for(Entry entry:entries.values()){total=Math.addExact(total,entry.size);if(total>maximumBytes)throw new IOException("The complete folder exceeds this workspace's file limit.");}
        File directory=new File(context.getCacheDir(),"gd-folder-inputs");if(!directory.exists()&&!directory.mkdirs())throw new IOException("Folder cache is unavailable.");
        long overhead=entries.size()*512L+16*1024*1024;
        if(directory.getUsableSpace()<total+overhead+512L*1024*1024)throw new IOException("Free more local space to prepare this complete folder.");
        File archive=File.createTempFile("selection-",".zip",directory);
        SelectionArchive result=new SelectionArchive(root.uri,archive,root.path+".zip",entries);
        try {
            try(FileOutputStream output=new FileOutputStream(archive);ZipOutputStream zip=new ZipOutputStream(new BufferedOutputStream(output),StandardCharsets.UTF_8)){
                zip.setLevel(0);
                for(Entry entry:entries.values()){
                    cancellation.check();ZipEntry item=new ZipEntry(entry.path+(entry.directory?"/":""));item.setTime(315532800000L);zip.putNextEntry(item);
                    if(!entry.directory){
                        try(InputStream input=context.getContentResolver().openInputStream(entry.uri)){
                            if(input==null)throw new IOException("A selected file cannot be read.");byte[] buffer=new byte[64*1024];int count;long written=0;
                            while((count=input.read(buffer))!=-1){cancellation.check();written+=count;if(written>entry.size)throw new IOException("A file changed while preparing the folder.");zip.write(buffer,0,count);}if(written!=entry.size)throw new IOException("A file changed while preparing the folder.");
                        }
                    }
                    zip.closeEntry();
                }
                zip.finish();zip.flush();output.getFD().sync();
            }
            if(archive.length()>maximumBytes)throw new IOException("The archived folder exceeds the workspace file limit.");
            result.verify(archive,cancellation);result.verifyOriginal(context,cancellation);return result;
        }catch(Exception error){archive.delete();throw error;}
    }
    void verify(File restored,Cancellation cancellation)throws Exception{
        Set<String> seen=new HashSet<>();
        try(ZipFile zip=new ZipFile(restored,StandardCharsets.UTF_8)){
            Enumeration<? extends ZipEntry> iterator=zip.entries();
            while(iterator.hasMoreElements()){
                cancellation.check();ZipEntry item=iterator.nextElement();String path=item.getName();if(path.endsWith("/"))path=path.substring(0,path.length()-1);
                Entry expected=entries.get(path);
                if(!seen.add(path)||expected==null||expected.directory!=item.isDirectory()||expected.size!=item.getSize())throw new IOException("Folder restore verification failed. Original retained.");
                if(!expected.directory&&!expected.sha256.equals(digest(zip.getInputStream(item),cancellation)))throw new IOException("Restored folder content differs. Original retained.");
            }
        }
        if(!seen.equals(entries.keySet()))throw new IOException("Restored folder is incomplete. Original retained.");
    }
    void verifyOriginal(Context context,Cancellation cancellation)throws Exception{
        Map<String,Entry> now=snapshot(context,root,cancellation);
        if(!now.keySet().equals(entries.keySet()))throw new IOException("Original folder changed; it was retained.");
        for(String path:now.keySet())if(!now.get(path).fingerprint().equals(entries.get(path).fingerprint()))throw new IOException("An original file changed; it was retained.");
    }
}
