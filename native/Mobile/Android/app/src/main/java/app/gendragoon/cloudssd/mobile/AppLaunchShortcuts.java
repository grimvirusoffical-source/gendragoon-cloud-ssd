package app.gendragoon.cloudssd.mobile;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import org.json.JSONObject;
import java.util.Locale;
import java.util.Set;

/** Small home-screen launchers; no account token or file path is embedded. */
final class AppLaunchShortcuts {
    static boolean isAndroid(JSONObject item) {
        String name=item.optString("name","").toLowerCase(Locale.ROOT);
        return !item.optBoolean("virtualFolder") && (name.endsWith(".apk") || name.endsWith(".aab"));
    }
    static Uri link(String receiver,String workspace,String key) {
        if(!receiver.matches("[a-f0-9]{64}")||!workspace.matches("[a-f0-9]{32}")||!key.matches("[a-f0-9]{18}"))
            throw new IllegalArgumentException("Invalid launcher identity.");
        return new Uri.Builder().scheme("gendragoon").authority("launch")
            .appendQueryParameter("receiver",receiver).appendQueryParameter("workspace",workspace)
            .appendQueryParameter("key",key).appendQueryParameter("platform","android").build();
    }
    static boolean valid(Uri uri) {
        if(uri==null || uri.toString().length()>1024 || !"gendragoon".equals(uri.getScheme())
                || !"launch".equals(uri.getHost()) || uri.getPort()!=-1 || uri.getUserInfo()!=null
                || uri.getFragment()!=null || (uri.getPath()!=null&&!uri.getPath().isEmpty()))return false;
        Set<String> fields=Set.of("receiver","workspace","key","platform");
        if(!uri.getQueryParameterNames().equals(fields))return false;
        for(String field:fields)if(uri.getQueryParameters(field).size()!=1)return false;
        return "android".equals(uri.getQueryParameter("platform"))
            && String.valueOf(uri.getQueryParameter("receiver")).matches("[a-f0-9]{64}")
            && String.valueOf(uri.getQueryParameter("workspace")).matches("[a-f0-9]{32}")
            && String.valueOf(uri.getQueryParameter("key")).matches("[a-f0-9]{18}");
    }
    static boolean pin(Context context,String receiver,String workspace,JSONObject item) {
        if(!isAndroid(item))throw new IllegalArgumentException("Only Android application backups get Android launchers.");
        if(Build.VERSION.SDK_INT<26)return false;
        ShortcutManager manager=context.getSystemService(ShortcutManager.class);
        if(manager==null||!manager.isRequestPinShortcutSupported())return false;
        String key=item.optString("key"),name=item.optString("displayName",item.optString("name","Cloud app"));
        if(name.length()>48)name=name.substring(0,48);
        Intent intent=new Intent(context,MainActivity.class).setAction(Intent.ACTION_VIEW)
            .setData(link(receiver,workspace,key)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_CLEAR_TOP);
        ShortcutInfo shortcut=new ShortcutInfo.Builder(context,"gd-"+receiver.substring(0,12)+"-"+workspace+"-"+key)
            .setShortLabel(name).setLongLabel(name+" · GenDragoon cloud launcher")
            .setIcon(Icon.createWithResource(context,R.mipmap.ic_launcher)).setIntent(intent).build();
        // Android displays its own Add to Home Screen approval; false != installed.
        return manager.requestPinShortcut(shortcut,null);
    }
    private AppLaunchShortcuts() {}
}
