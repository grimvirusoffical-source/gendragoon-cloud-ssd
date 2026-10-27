package app.gendragoon.cloudssd.mobile;

import android.content.Context;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Instant;
import java.util.*;

/** Current MachineNotes deletion receipts. Legacy Firebase deletion is not used. */
final class MachineNoteDeletion {
    static final String ROUTE="/gendragoon/v2/account/deletion",CONFIRMATION="DELETE GENDRAGOON";
    private static final String PREF="machinenotes-account-deletion-v1";
    static final class Pending {
        final String issuer,subject,receiver,key,id;
        Pending(String issuer,String subject,String receiver,String key,String id)throws IOException {
            if(!CloudApi.ISSUER.equals(issuer)||subject==null||TextChecks.isBlank(subject)||subject.length()>1024||!RedXSession.receiver(subject).equals(receiver)||!key.matches("[a-f0-9]{32}")||!(id.isEmpty()||id.matches("[a-f0-9]{32}")))throw new IOException("Invalid saved MachineNotes deletion request. Existing data was retained.");
            this.issuer=issuer;this.subject=subject;this.receiver=receiver;this.key=key;this.id=id;
        }
        JSONObject json()throws JSONException{return new JSONObject().put("schema",1).put("issuer",issuer).put("subject",subject).put("receiverId",receiver).put("key",key).put("receiptId",id);}
        boolean matches(JSONObject profile){return profile!=null&&issuer.equals(profile.optString("issuer"))&&subject.equals(profile.optString("subject"))&&receiver.equals(profile.optString("receiverId"));}
        Pending bind(String receipt)throws IOException {if(!id.isEmpty()&&!id.equals(receipt))throw new IOException("The deletion receipt changed. Existing local data was retained.");return new Pending(issuer,subject,receiver,key,receipt);}
        @Override public String toString(){return "MachineNotes deletion request";}
    }
    static final class Receipt {
        final String id,status,phase,error;final boolean complete,retryable;
        Receipt(String id,String status,String phase,String error,boolean complete,boolean retryable){this.id=id;this.status=status;this.phase=phase;this.error=error;this.complete=complete;this.retryable=retryable;}
        String message(){if(complete)return "Cloud deletion completed. Finishing this account's local cleanup…";if(status.equals("failed"))return error.equals("billing_review_required")?"Deletion paused for billing review. Keep this receipt and contact support. Local keys and data remain available.":"Deletion paused. Retry this same request; local keys and data were retained.";return "Deletion "+status+" · "+phase+". Keep this request; local keys and data remain until verified completion.";}
    }
    private static String string(JSONObject object,String field)throws Exception{Object value=object.get(field);if(!(value instanceof String))throw new IOException("Invalid deletion receipt.");return (String)value;}
    private static boolean bool(JSONObject object,String field)throws Exception{Object value=object.get(field);if(!(value instanceof Boolean))throw new IOException("Invalid deletion receipt.");return (Boolean)value;}
    static Receipt parse(JSONObject body,Pending pending,boolean post)throws Exception {
        if(!(body.get("schema") instanceof Number)||((Number)body.get("schema")).doubleValue()!=1.0)throw new IOException("Unsupported deletion receipt.");
        if(body.isNull("deletion"))return null;
        JSONObject row=body.getJSONObject("deletion");String id=string(row,"id"),status=string(row,"status"),phase=string(row,"phase");
        if(!id.matches("[a-f0-9]{32}")||!Set.of("queued","running","failed","completed").contains(status)||!Set.of("billing","workspaces","metadata","storage","complete").contains(phase)||!pending.id.isEmpty()&&!pending.id.equals(id))throw new IOException("The deletion receipt does not match this request. Local data was retained.");
        Instant requested=Instant.parse(string(row,"requestedAt")),updated=Instant.parse(string(row,"updatedAt"));if(updated.isBefore(requested))throw new IOException("Invalid deletion receipt time.");
        boolean completed=status.equals("completed"),retryable=bool(row,"retryable"),deleted=bool(row,"cloudDataDeleted");
        if(retryable!=status.equals("failed")||deleted!=completed||completed!=phase.equals("complete")||bool(row,"externalIdentityDeleted")||bool(row,"externalBYODataDeleted")||bool(row,"localOriginalsDeleted"))throw new IOException("Invalid deletion completion proof. Local data was retained.");
        if(completed){Instant finished=Instant.parse(string(row,"completedAt"));if(finished.isBefore(requested)||finished.isAfter(updated))throw new IOException("Invalid deletion completion time.");}
        String error=status.equals("failed")?string(row,"error"):"";if(status.equals("failed")&&!Set.of("account_deletion_retry_required","billing_review_required").contains(error))throw new IOException("Unsupported deletion failure receipt.");
        // Only the response to our idempotent POST can initially bind an ID.
        // A GET with no bound ID can describe a request from another client.
        return new Receipt(id,status,phase,error,completed&&(post||!pending.id.isEmpty()),retryable);
    }
    static Pending load(Context context)throws Exception {String raw=SecurePrefs.get(context,PREF);if(raw==null)return null;JSONObject saved=new JSONObject(raw);if(saved.getInt("schema")!=1)throw new IOException("Unsupported saved deletion request.");return new Pending(saved.getString("issuer"),saved.getString("subject"),saved.getString("receiverId"),saved.getString("key"),saved.getString("receiptId"));}
    static void save(Context context,Pending pending)throws Exception {SecurePrefs.put(context,PREF,pending.json().toString());}
    static Pending begin(Context context,JSONObject profile)throws Exception {
        synchronized(TransferLease.class){if(TransferLease.active())throw new IOException("Wait for the active encrypted transfer to finish before deleting this account.");Pending existing=load(context);if(existing!=null){if(!existing.matches(profile))throw new IOException("Reconnect the account associated with the pending deletion request.");return existing;}Pending pending=new Pending(CloudApi.ISSUER,profile.getString("subject"),profile.getString("receiverId"),UUID.randomUUID().toString().replace("-",""),"");save(context,pending);return pending;}
    }
    static Receipt request(Context context,Pending pending,boolean post)throws Exception {
        if(!pending.matches(RedXSession.profile(context)))throw new IOException("Reconnect the same Red-XAI account to resume its deletion request.");
        // Renew the current account proof; Control also validates userinfo itself.
        RedXSession.access(context,pending.subject,true);
        JSONObject body=post?new JSONObject().put("confirmation",CONFIRMATION).put("idempotencyKey",pending.key):null;
        JSONObject result=new CloudApi(context,pending.subject).request(ROUTE,post?"POST":"GET",body).json();
        if(!pending.matches(RedXSession.profile(context)))throw new IOException("The connected account changed. Local data was retained.");
        Receipt receipt=parse(result,pending,post);if(receipt!=null&&post)save(context,pending.bind(receipt.id));return receipt;
    }
    static void completedCleanup(Context context,Pending pending,Receipt receipt)throws Exception {
        synchronized(TransferLease.class){Pending stored=load(context);authorizeCleanup(stored,pending,receipt,RedXSession.profile(context),TransferLease.active());
            cleanupAccountFiles(context.getFilesDir(),stored.receiver);
            SecurePrefs.remove(context,"vault:"+stored.receiver);
            RedXSession.disconnect(context); // Revokes this app's refresh token; not the external identity.
            SecurePrefs.remove(context,PREF); // Last: interrupted cleanup retains its recovery receipt.
        }
    }
    static void authorizeCleanup(Pending stored,Pending requested,Receipt receipt,JSONObject profile,boolean active)throws IOException {
        if(stored==null||requested==null||receipt==null||!receipt.complete||stored.id.isEmpty()||!stored.id.equals(receipt.id)||!stored.key.equals(requested.key)||!stored.receiver.equals(requested.receiver)||!stored.subject.equals(requested.subject)||!stored.matches(profile)||active)throw new IOException("Verified deletion completion is required before local cleanup.");
    }
    static void cleanupAccountFiles(File suppliedFiles,String receiver)throws IOException {
        if(receiver==null||!receiver.matches("[a-f0-9]{64}"))throw new IOException("Invalid account cleanup scope.");
            File files=suppliedFiles.getCanonicalFile();File vault=new File(files,"redx-vault/"+receiver);if(!vault.getCanonicalFile().equals(vault.getAbsoluteFile()))throw new IOException("Linked private vault cleanup scope rejected.");removeTree(vault.toPath());
            File jobs=new File(files,"redx-jobs");if(!jobs.getCanonicalFile().equals(jobs.getAbsoluteFile()))throw new IOException("Linked private transfer cleanup scope rejected.");File[] children=jobs.listFiles();if(children!=null)for(File job:children){if(Files.isSymbolicLink(job.toPath())||!job.isDirectory()||!job.getName().matches("[a-f0-9-]{36}"))continue;Path marker=job.toPath().resolve("account.receiver");if(Files.isRegularFile(marker,LinkOption.NOFOLLOW_LINKS)&&Files.size(marker)==64&&new String(Files.readAllBytes(marker),StandardCharsets.US_ASCII).equals(receiver))removeTree(job.toPath());}
    }
    static void removeTree(Path directory)throws IOException {
        if(!Files.exists(directory,LinkOption.NOFOLLOW_LINKS))return;
        if(Files.isSymbolicLink(directory)||!Files.isDirectory(directory,LinkOption.NOFOLLOW_LINKS))throw new IOException("Linked private cleanup directory rejected.");
        Files.walkFileTree(directory,new SimpleFileVisitor<Path>(){
            @Override public FileVisitResult visitFile(Path path,BasicFileAttributes attrs)throws IOException {Files.delete(path);return FileVisitResult.CONTINUE;}
            @Override public FileVisitResult postVisitDirectory(Path path,IOException error)throws IOException {if(error!=null)throw error;Files.delete(path);return FileVisitResult.CONTINUE;}
        });
    }
}
