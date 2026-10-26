package app.gendragoon.cloudssd.mobile;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import android.content.Context;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public final class PinnedRuntimeTest {
    @Test public void actualPinnedNativeCryptoAndVisualRendererRoundtripOnDevice()throws Exception{Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();File root=new File(context.getCacheDir(),"test-codec-"+java.util.UUID.randomUUID());JSONObject result=new JSONObject(CryptoRuntime.module(context).callAttr("codec_selftest",root.getCanonicalPath()).toString());assertTrue(result.getBoolean("ok"));assertTrue(result.getInt("pngBytes")>result.getInt("plainBytes"));}
    @Test public void actualArchiveIndexMetadataReadbackAndAadIsolationRoundtripOnDevice()throws Exception{Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();CryptoRuntime.module(context);File root=new File(context.getCacheDir(),"test-graph-"+java.util.UUID.randomUUID());JSONObject result=new JSONObject(com.chaquo.python.Python.getInstance().getModule("gendragoon_android_fixture").callAttr("roundtrip",root.getCanonicalPath()).toString());assertTrue(result.getBoolean("verified"));assertTrue(result.getBoolean("crossWorkspaceRejected"));assertTrue(result.getInt("pngObjects")>=4);}
    @Test public void macPortableVaultJceInteropAndReadonlyCoreAuthenticationWorkOnDevice()throws Exception{Context target=InstrumentationRegistry.getInstrumentation().getTargetContext(),tests=InstrumentationRegistry.getInstrumentation().getContext();byte[] raw;try(InputStream input=tests.getAssets().open("portable-vault-v1.json");ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] buffer=new byte[4096];int n;while((n=input.read(buffer))!=-1)out.write(buffer,0,n);raw=out.toByteArray();}JSONObject f=new JSONObject(new String(raw,StandardCharsets.UTF_8));PortableVault.Keys keys=PortableVault.open(f.getJSONObject("envelope").toString().getBytes(StandardCharsets.UTF_8),f.getString("password").toCharArray(),f.getString("receiverId"));File keymap=new File(target.getCacheDir(),"test-portable-"+java.util.UUID.randomUUID());Files.write(keymap.toPath(),keys.keymap);try{CryptoRuntime.verifyKeymap(target,keymap,keys.secret);assertTrue(Arrays.equals(keys.keymap,Files.readAllBytes(keymap.toPath())));}finally{keymap.delete();Arrays.fill(keys.keymap,(byte)0);}}
}
