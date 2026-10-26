package app.gendragoon.cloudssd.mobile;

import android.app.Activity;
import android.content.*;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Bundle;

/** The provider owner grants only its public fixture URI to its instrumentation target. */
public final class FixtureGrantActivity extends Activity {
    @Override public void onCreate(Bundle state){
        super.onCreate(state);
        try{
            PackageInfo info=getPackageManager().getPackageInfo(getPackageName(),android.content.pm.PackageManager.GET_INSTRUMENTATION);
            String caller=getCallingPackage();boolean target=false;
            if(info.instrumentation!=null)for(android.content.pm.InstrumentationInfo instrument:info.instrumentation)if(instrument.targetPackage.equals(caller))target=true;
            if(!target)throw new SecurityException("Only the owned instrumentation target can request fixture grants.");
            String mode=getIntent().getStringExtra("mode");
            if("revoke".equals(mode)){
                Uri uri=Uri.parse(getIntent().getStringExtra("uri"));
                if(!FixtureDocumentsProvider.AUTHORITY.equals(uri.getAuthority()))throw new SecurityException("Foreign grant rejected.");
                revokeUriPermission(uri,Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);setResult(RESULT_OK);
            }else{
                Uri uri;
                if("existing".equals(mode)){
                    uri=Uri.parse(getIntent().getStringExtra("uri"));
                    if(!FixtureDocumentsProvider.AUTHORITY.equals(uri.getAuthority()))throw new SecurityException("Foreign grant rejected.");
                    String id=android.provider.DocumentsContract.isTreeUri(uri)?android.provider.DocumentsContract.getTreeDocumentId(uri):android.provider.DocumentsContract.getDocumentId(uri);
                    try(android.database.Cursor cursor=getContentResolver().query(android.provider.DocumentsContract.buildDocumentUri(FixtureDocumentsProvider.AUTHORITY,id),null,null,null,null)){if(cursor==null||!cursor.moveToFirst())throw new SecurityException("Unknown owned document.");}
                }else uri=FixtureDocumentsProvider.create(this,mode);
                int flags=Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION|Intent.FLAG_GRANT_PREFIX_URI_PERMISSION;
                if(mode.startsWith("output"))flags|=Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
                Intent result=new Intent().setData(uri).addFlags(flags);
                result.setClipData(ClipData.newRawUri("Owned fixture",uri));
                setResult(RESULT_OK,result);
            }
        }catch(Exception error){setResult(RESULT_CANCELED,new Intent().putExtra("fixtureError",error.getClass().getSimpleName()));}
        finish();
    }
}
