package app.gendragoon.cloudssd.mobile;

import android.app.Activity;
import android.content.*;
import android.net.Uri;
import android.os.Bundle;
import android.widget.TextView;
import androidx.activity.ComponentActivity;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import java.util.concurrent.atomic.AtomicInteger;

/** An isolated owned lifecycle host, not a replacement for system-picker consent. */
public final class TransferAcceptanceActivity extends ComponentActivity {
    private ActivityResultLauncher<Intent> grant;
    volatile Uri selected;
    final AtomicInteger results=new AtomicInteger();
    @Override public void onCreate(Bundle saved){
        super.onCreate(saved);
        if(saved!=null){String value=saved.getString("fixtureUri");if(value!=null)selected=Uri.parse(value);}
        grant=registerForActivityResult(new ActivityResultContracts.StartActivityForResult(),result->{
            Intent data=result.getData();
            if(result.getResultCode()==Activity.RESULT_OK&&data!=null&&data.getData()!=null){
                selected=data.getData();
                int flags=data.getFlags()&(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                if(flags==(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION))
                    getContentResolver().takePersistableUriPermission(selected,Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                else if(flags==Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    getContentResolver().takePersistableUriPermission(selected,Intent.FLAG_GRANT_READ_URI_PERMISSION);
                else if(flags==Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                    getContentResolver().takePersistableUriPermission(selected,Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                else throw new SecurityException("Owned fixture did not return a readable or writable URI grant.");
            }
            results.incrementAndGet();
        });
        TextView label=new TextView(this);label.setText("Owned GenDragoon transfer acceptance fixture");setContentView(label);
    }
    @Override protected void onSaveInstanceState(Bundle saved){if(selected!=null)saved.putString("fixtureUri",selected.toString());super.onSaveInstanceState(saved);}
    void requestFixture(String owner,String mode){grant.launch(new Intent().setComponent(new ComponentName(owner,"app.gendragoon.cloudssd.mobile.FixtureGrantActivity")).putExtra("mode",mode));}
    void regrantFixture(String owner,Uri uri){grant.launch(new Intent().setComponent(new ComponentName(owner,"app.gendragoon.cloudssd.mobile.FixtureGrantActivity")).putExtra("mode","existing").putExtra("uri",uri.toString()));}
    void revokeFixture(String owner,Uri uri){grant.launch(new Intent().setComponent(new ComponentName(owner,"app.gendragoon.cloudssd.mobile.FixtureGrantActivity")).putExtra("mode","revoke").putExtra("uri",uri.toString()));}
}
