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

/** S3-compatible keys saved only in keystore-backed preferences. The server never receives them. */
final class ByoSecretStore {
    static final String PREF="gd-byo-credentials";
    static final String ALIAS="gd-byo-credentials-key";
    private ByoSecretStore(){}

    static void save(Context context,String endpoint,String bucket,String accessKey,String secret)throws Exception{
        if(endpoint==null||endpoint.isEmpty()||bucket==null||bucket.isEmpty()||accessKey==null||accessKey.isEmpty()||secret==null||secret.isEmpty())
            throw new IllegalArgumentException("Endpoint, bucket, and keys are required.");
        String payload=endpoint+"\n"+bucket+"\n"+accessKey+"\n"+secret;
        SharedPreferences prefs=context.getSharedPreferences(PREF,Context.MODE_PRIVATE);
        prefs.edit().putString("s3",encrypt(payload)).commit();
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
}
