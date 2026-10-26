package app.gendragoon.cloudssd.mobile;
import android.content.Context;
import android.security.keystore.*;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.*;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;

/** OS-held wrapping key; neither raw tokens nor vault secrets enter preferences. */
final class SecurePrefs {
    private static final String ALIAS="gendragoon-redx-secure-v1",PREF="gendragoon-redx-private-v1";
    private static SecretKey key()throws Exception{KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);if(store.containsAlias(ALIAS))return (SecretKey)store.getKey(ALIAS,null);KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");generator.init(new KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setRandomizedEncryptionRequired(true).build());return generator.generateKey();}
    static synchronized void put(Context context,String name,String value)throws Exception{if(value==null||value.getBytes(StandardCharsets.UTF_8).length>16384)throw new IllegalArgumentException("Invalid private credential size.");Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key());cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));byte[] encrypted=cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)),iv=cipher.getIV(),packed=new byte[iv.length+encrypted.length];System.arraycopy(iv,0,packed,0,iv.length);System.arraycopy(encrypted,0,packed,iv.length,encrypted.length);if(!context.getSharedPreferences(PREF,Context.MODE_PRIVATE).edit().putString(name,Base64.getEncoder().encodeToString(packed)).commit())throw new java.io.IOException("Private credentials could not be saved.");Arrays.fill(packed,(byte)0);}
    static synchronized String get(Context context,String name)throws Exception{String saved=context.getSharedPreferences(PREF,Context.MODE_PRIVATE).getString(name,null);if(saved==null)return null;byte[] packed=Base64.getDecoder().decode(saved);if(packed.length<29||packed.length>20000)throw new java.io.IOException("Private credential storage is invalid.");Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,packed,0,12));cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));byte[] result=cipher.doFinal(packed,12,packed.length-12);try{return new String(result,StandardCharsets.UTF_8);}finally{Arrays.fill(result,(byte)0);Arrays.fill(packed,(byte)0);}}
    static synchronized void remove(Context context,String name)throws Exception{if(!context.getSharedPreferences(PREF,Context.MODE_PRIVATE).edit().remove(name).commit())throw new java.io.IOException("Private session could not be disconnected.");}
}
