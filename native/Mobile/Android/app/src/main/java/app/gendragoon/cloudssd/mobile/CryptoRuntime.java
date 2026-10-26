package app.gendragoon.cloudssd.mobile;
import android.content.Context;
import com.chaquo.python.*;
import com.chaquo.python.android.AndroidPlatform;
import java.io.File;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import org.json.JSONObject;

public final class CryptoRuntime {
    private static PyObject module;
    public interface Reporter {void report(String json);}
    public static final class Auth {
        private final Context context;private final String subject;
        public Auth(Context context,String subject){this.context=context.getApplicationContext();this.subject=subject;}
        public String token(boolean force)throws Exception{return RedXSession.access(context,subject,force);}
        public String renew(String rejected)throws Exception{return RedXSession.renew(context,subject,rejected);}
    }
    static synchronized PyObject module(Context context)throws Exception{if(module!=null)return module;if(!Python.isStarted())Python.start(new AndroidPlatform(context.getApplicationContext()));PyObject candidate=Python.getInstance().getModule("gendragoon_android");File temporary=new File(context.getCacheDir(),"redx-python");String compiled;try(InputStream input=context.getAssets().open("gendragoon-crypto/compiled-python.zip");ByteArrayOutputStream output=new ByteArrayOutputStream()){byte[] buffer=new byte[8192];int count;while((count=input.read(buffer))!=-1){if(output.size()+count>8*1024*1024)throw new java.io.IOException("Packaged crypto bytecode exceeds its bound.");output.write(buffer,0,count);}compiled=android.util.Base64.encodeToString(output.toByteArray(),android.util.Base64.NO_WRAP);}candidate.callAttr("initialize",new File(context.getApplicationInfo().nativeLibraryDir,"librsx.so").getAbsolutePath(),temporary.getAbsolutePath(),compiled);module=candidate;return module;}
    static void verifyKeymap(Context context,File keymap,String secret)throws Exception{JSONObject result=new JSONObject(module(context).callAttr("verify_vault",keymap.getCanonicalPath(),secret).toString());if(!result.optBoolean("ok"))throw new java.io.IOException("Private vault authentication failed.");}
}
