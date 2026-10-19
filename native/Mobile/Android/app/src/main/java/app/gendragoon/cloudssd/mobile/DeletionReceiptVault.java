package app.gendragoon.cloudssd.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Keystore-backed encrypted preferences for the deletion job id and status token.
 * Values in {@code gd-deletion-receipt} are ciphertext. The token is never logged.
 * This is not plain SharedPreferences.
 */
final class DeletionReceiptVault {
    static final String PREF=LocalDataWipe.DELETION_RECEIPT;
    static final String ALIAS=LocalDataWipe.DELETION_KEY_ALIAS;
    static final boolean STORES_PLAINTEXT=false;
    private static final String KEY_JOB="job";
    private static final String KEY_TOKEN="token";
    private static final String KEY_UID="uid";

    private DeletionReceiptVault(){}

    static DeletionReceipt read(Context context){
        try{
            SharedPreferences prefs=context.getSharedPreferences(PREF,Context.MODE_PRIVATE);
            String job=decrypt(prefs.getString(KEY_JOB,null));
            String token=decrypt(prefs.getString(KEY_TOKEN,null));
            String uid=decrypt(prefs.getString(KEY_UID,null));
            return DeletionReceipt.of(job,token,uid);
        }catch(Exception error){return null;}
    }

    static void save(Context context,DeletionReceipt receipt){
        if(context==null||receipt==null)return;
        try{
            SharedPreferences prefs=context.getSharedPreferences(PREF,Context.MODE_PRIVATE);
            prefs.edit().putString(KEY_JOB,encrypt(receipt.jobId)).putString(KEY_TOKEN,encrypt(receipt.statusToken)).putString(KEY_UID,encrypt(receipt.accountUid==null?"":receipt.accountUid)).commit();
        }catch(Exception error){/* keep the in-memory job; do not log the token */ }
    }

    static void clear(Context context){
        if(context==null)return;
        context.getSharedPreferences(PREF,Context.MODE_PRIVATE).edit().clear().commit();
        try{
            KeyStore store=KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            if(store.containsAlias(ALIAS))store.deleteEntry(ALIAS);
        }catch(Exception ignored){}
    }

    private static SecretKey key()throws Exception{
        KeyStore store=KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if(store.containsAlias(ALIAS))return (SecretKey)store.getKey(ALIAS,null);
        KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setRandomizedEncryptionRequired(true).build());
        return generator.generateKey();
    }

    private static String encrypt(String value)throws Exception{
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE,key());
        byte[] iv=cipher.getIV();
        byte[] body=cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        byte[] packed=new byte[iv.length+body.length];
        System.arraycopy(iv,0,packed,0,iv.length);
        System.arraycopy(body,0,packed,iv.length,body.length);
        return Base64.encodeToString(packed,Base64.NO_WRAP);
    }

    private static String decrypt(String packed)throws Exception{
        if(packed==null||packed.isEmpty())return null;
        byte[] all=Base64.decode(packed,Base64.NO_WRAP);
        if(all.length<13)return null;
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,all,0,12));
        return new String(cipher.doFinal(all,12,all.length-12),StandardCharsets.UTF_8);
    }
}
