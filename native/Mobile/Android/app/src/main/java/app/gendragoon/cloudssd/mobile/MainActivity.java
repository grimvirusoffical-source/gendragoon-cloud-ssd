package app.gendragoon.cloudssd.mobile;

import android.Manifest;
import android.content.*;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.*;
import android.provider.Settings;
import android.text.*;
import android.text.format.Formatter;
import android.view.*;
import android.widget.*;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.FileProvider;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.credentials.*;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.work.*;
import com.google.android.libraries.identity.googleid.*;
import com.google.firebase.auth.*;
import com.google.android.material.button.MaterialButton;
import com.google.android.material.card.MaterialCardView;
import com.google.android.material.dialog.MaterialAlertDialogBuilder;
import com.google.android.material.progressindicator.LinearProgressIndicator;
import com.google.android.material.switchmaterial.SwitchMaterial;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.*;
import java.util.concurrent.*;

public final class MainActivity extends AppCompatActivity {
    private final int background=Color.rgb(16,16,26),surface=Color.rgb(30,24,42),accent=Color.rgb(197,160,255),muted=Color.rgb(183,171,203);
    private final ExecutorService io=Executors.newFixedThreadPool(3);
    private final Handler main=new Handler(Looper.getMainLooper());
    private FirebaseAuth auth;private CredentialManager credentials;private FirebaseAuth.AuthStateListener listener;
    private LinearLayout root,content,fileList;private TextView status,transferText;private LinearProgressIndicator transferProgress;
    private MaterialButton upload,folderUpload,pause,refresh;private SwitchMaterial saver;private CheckBox removeOriginals;private boolean applicationsOnly=false;
    private long loadSerial=0;
    private String uid="",workspace="free",query="",sort="name";private boolean loading=false,workBusy=false;private int pageSize=100;
    private List<JSONObject> files=new ArrayList<>();private final Set<UUID> handled=new HashSet<>();
    private boolean holdAuthNavigation=false;private WorkspaceLock activeLock;private AccountDeletion deletion;
    private boolean deletionSignInStarted=false,deletionAuthBusy=false,wiping=false;private int deletionEpoch=0;
    private String deletionOwnerUid="",deletionOwnerEmail="",deletionOwnerGoogleId="";
    private boolean foreignSession=false;
    private final List<WorkspaceLock.Item> knownSpaces=new ArrayList<>();private boolean lockNamesRequested=false;
    private final List<JSONObject> lockFiles=new ArrayList<>();private String lockFilesFor="";
    private ActivityResultLauncher<String[]> picker;private ActivityResultLauncher<Uri> folderPicker;private ActivityResultLauncher<String> notifications;
    private CloudApi api(){return new CloudApi(uid);}
    @Override public void onCreate(Bundle state){
        super.onCreate(state);auth=FirebaseAuth.getInstance();credentials=CredentialManager.create(this);
        picker=registerForActivityResult(new ActivityResultContracts.OpenMultipleDocuments(),uris->chooseUpload(uris,false));
        folderPicker=registerForActivityResult(new ActivityResultContracts.OpenDocumentTree(),uri->{if(uri!=null)chooseUpload(List.of(uri),true);});
        notifications=registerForActivityResult(new ActivityResultContracts.RequestPermission(),allowed->{if(!allowed)say("Transfer started. Notifications are off; progress remains available in the app.");});
        listener=firebase->{FirebaseUser user=firebase.getCurrentUser();if(holdAuthNavigation){uid=user==null?"":user.getUid();return;}loadSerial++;uid=user==null?"":user.getUid();workspace=user==null?"free":getSharedPreferences("gd-settings",MODE_PRIVATE).getString("workspace:"+uid,"free");files.clear();query="";handled.clear();if(user==null)showLogin();else checkConsent();};
        DeletionReceipt savedDeletion=DeletionReceiptVault.read(this);
        if(savedDeletion!=null){
            holdAuthNavigation=true;
            FirebaseUser current=auth.getCurrentUser();
            deletionOwnerUid=DeletionSignIn.ownerUid(savedDeletion,current==null?"":current.getUid());
            deletionOwnerEmail=current==null||current.getEmail()==null?"":current.getEmail();
            deletionOwnerGoogleId=googleProviderId(current);
            deletion=AccountDeletion.resume(savedDeletion);
        }
        auth.addAuthStateListener(listener);
        if(deletion!=null){showDeleteAccount();advanceDeletion();}
        WorkManager.getInstance(this).getWorkInfosForUniqueWorkLiveData("GenDragoonTransfer").observe(this,items->{
            boolean previous=workBusy;workBusy=false;
            for(WorkInfo item:items){if(item.getState()==WorkInfo.State.RUNNING||item.getState()==WorkInfo.State.ENQUEUED||item.getState()==WorkInfo.State.BLOCKED){workBusy=true;Data p=item.getProgress();long total=p.getLong("total",0),done=p.getLong("done",0);
                if(transferProgress!=null){transferProgress.setVisibility(View.VISIBLE);transferProgress.setProgressCompat(total>0?(int)(100*done/total):0,true);}if(transferText!=null)transferText.setText(p.getString("message")==null?"Transfer queued…":p.getString("message"));}
                if(item.getState()==WorkInfo.State.FAILED&&handled.add(item.getId())){
                    Data out=item.getOutputData();
                    CloudSignals.Presentation presentation=CloudSignals.present(new CloudSignals.FailureNotice(out.getString("route"),out.getString("message"),out.getString("lock")));
                    if(presentation.lockScreen)showLock(WorkspaceLock.decode(out.getString("lock")));
                    else if(presentation.toast!=null)say(presentation.toast);
                }
                if(item.getState()==WorkInfo.State.SUCCEEDED&&"download".equals(item.getOutputData().getString("action"))&&uid.equals(item.getOutputData().getString("uid"))&&handled.add(item.getId()))showSaved(item.getOutputData().getString("path"));
            }
            updateButtons();if(previous&&!workBusy&&!uid.isEmpty()&&activeLock==null&&deletion==null)load();
        });
    }
    @Override protected void onDestroy(){if(listener!=null)auth.removeAuthStateListener(listener);io.shutdownNow();super.onDestroy();}
    private int dp(float n){return Math.round(n*getResources().getDisplayMetrics().density);}
    private TextView text(String value,int sp,boolean bold){TextView t=new TextView(this);t.setText(value);t.setTextSize(sp);t.setTextColor(Color.WHITE);t.setTypeface(Typeface.create("sans-serif",bold?Typeface.BOLD:Typeface.NORMAL));t.setLineSpacing(dp(3),1);return t;}
    private void space(LinearLayout parent,int size){View v=new View(this);parent.addView(v,new LinearLayout.LayoutParams(1,dp(size)));}
    private LinearLayout vertical(){LinearLayout p=new LinearLayout(this);p.setOrientation(LinearLayout.VERTICAL);return p;}
    private MaterialButton button(String label,Runnable action){MaterialButton b=new MaterialButton(this);b.setText(label);b.setAllCaps(false);b.setCornerRadius(dp(12));b.setMinHeight(dp(48));b.setTextColor(Color.rgb(30,16,43));b.setBackgroundTintList(ColorStateList.valueOf(accent));b.setOnClickListener(v->action.run());return b;}
    private MaterialCardView card(LinearLayout parent){MaterialCardView c=new MaterialCardView(this);c.setCardBackgroundColor(surface);c.setRadius(dp(19));c.setStrokeColor(Color.rgb(62,47,81));c.setStrokeWidth(dp(1));c.setCardElevation(0);LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1,-2);lp.setMargins(0,dp(8),0,dp(8));parent.addView(c,lp);return c;}
    private LinearLayout inside(MaterialCardView card){LinearLayout p=vertical();p.setPadding(dp(19),dp(20),dp(19),dp(20));card.addView(p);return p;}
    private void shell(){
        root=vertical();root.setBackgroundColor(background);setContentView(root);
        ViewCompat.setOnApplyWindowInsetsListener(root,(v,insets)->{androidx.core.graphics.Insets bars=insets.getInsets(WindowInsetsCompat.Type.systemBars());v.setPadding(bars.left,bars.top,bars.right,bars.bottom);return insets;});
        LinearLayout bar=new LinearLayout(this);bar.setGravity(Gravity.CENTER_VERTICAL);bar.setPadding(dp(21),dp(12),dp(16),dp(8));TextView logo=text("GENDRAGOON  /  CLOUD SSD",10,true);logo.setLetterSpacing(.12f);logo.setTextColor(accent);bar.addView(logo,new LinearLayout.LayoutParams(0,-2,1));
        if(!uid.isEmpty()){MaterialButton account=button("Account",this::account);account.setTextSize(10);account.setBackgroundTintList(ColorStateList.valueOf(surface));account.setTextColor(accent);bar.addView(account);}
        root.addView(bar);ScrollView scroll=new ScrollView(this);scroll.setFillViewport(true);content=vertical();content.setPadding(dp(20),dp(15),dp(20),dp(32));scroll.addView(content);root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        status=null;transferProgress=null;transferText=null;upload=null;folderUpload=null;removeOriginals=null;pause=null;refresh=null;saver=null;
    }
    private void status(){status=text("",12,false);status.setTextColor(muted);status.setPadding(dp(3),dp(13),dp(3),dp(8));content.addView(status);}
    private void say(String message){if(message==null)return;runOnUiThread(()->{if(status!=null)status.setText(message);});}
    private void report(Exception error){Exception cause=CloudSignals.unwrap(error);if(cause instanceof WorkspaceLocked locked){runOnUiThread(()->showLock(locked.lock));return;}say(cause.getMessage());}
    private void showLogin(){shell();space(content,42);TextView cloud=text("☁",88,true);cloud.setTextColor(accent);content.addView(cloud);space(content,17);content.addView(text("Your cloud.\nWithin reach.",43,true));space(content,18);TextView sub=text("Private files, less clutter. Upload, restore and share across your devices.",16,false);sub.setTextColor(muted);content.addView(sub);space(content,28);
        LinearLayout panel=inside(card(content));panel.addView(text("2 GB free to get started",19,true));space(panel,14);panel.addView(text("Resumable transfers · Integrity checks\nNative file picking · Safe sharing",13,false));space(panel,20);panel.addView(button("Continue with Google",this::signIn));status();say("Your Google password is entered only on Google's secure page.");}
    private void signIn(){
        if(loading)return;loading=true;say("Opening secure Google sign-in…");
        GetGoogleIdOption option=new GetGoogleIdOption.Builder().setServerClientId(getString(R.string.default_web_client_id)).setFilterByAuthorizedAccounts(false).setAutoSelectEnabled(false).build();
        GetCredentialRequest request=new GetCredentialRequest.Builder().addCredentialOption(option).build();
        credentials.getCredentialAsync(this,request,new CancellationSignal(),getMainExecutor(),new CredentialManagerCallback<GetCredentialResponse,GetCredentialException>(){
            @Override public void onResult(GetCredentialResponse result){
                try{Credential c=result.getCredential();if(!(c instanceof CustomCredential)||!GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(c.getType()))throw new IllegalStateException("Unexpected Google credential.");
                    GoogleIdTokenCredential google=GoogleIdTokenCredential.createFrom(c.getData());auth.signInWithCredential(GoogleAuthProvider.getCredential(google.getIdToken(),null)).addOnCompleteListener(MainActivity.this,task->{loading=false;if(!task.isSuccessful())say(task.getException()==null?"Sign-in failed.":task.getException().getMessage());});
                }catch(Exception e){loading=false;say(e.getMessage());}
            }
            @Override public void onError(@NonNull GetCredentialException error){loading=false;say(error.getMessage()==null?"Google sign-in was cancelled or unavailable.":error.getMessage());}
        });
    }
    private void checkConsent(){String owner=uid;shell();content.addView(text("Opening your cloud…",27,true));status();
        io.execute(()->{try{boolean accepted=new CloudApi(owner).termsAccepted();runOnUiThread(()->{if(!owner.equals(uid))return;if(accepted)load();else showTerms();});}catch(Exception e){if(e instanceof WorkspaceLocked)report(e);else{say("Could not verify your Terms record. "+e.getMessage());runOnUiThread(()->content.addView(button("Retry",this::checkConsent)));}}});
    }
    private String asset(String name)throws IOException{try(InputStream in=getAssets().open(name);ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] b=new byte[8192];int n;while((n=in.read(b))>=0)out.write(b,0,n);return out.toString("UTF-8");}}
    private void showTerms(){shell();content.addView(text("Before you begin",30,true));space(content,12);content.addView(text("Read the Terms before saving your agreement to your Google account.",14,false));
        LinearLayout panel=inside(card(content));TextView body=text("",12,false);try{body.setText(asset("terms.txt"));}catch(Exception e){body.setText("Terms unavailable. Do not continue.");}body.setTextIsSelectable(true);panel.addView(body);
        CheckBox read=new CheckBox(this);read.setText("I confirm I have read the Terms");content.addView(read);CheckBox agree=new CheckBox(this);agree.setText("I agree to the Terms and Privacy Notice");content.addView(agree);
        content.addView(button("Read the Privacy Notice",()->{try{new MaterialAlertDialogBuilder(this).setTitle("Privacy Notice").setMessage(asset("privacy.txt")).setPositiveButton("Done",null).show();}catch(Exception e){say(e.getMessage());}}));
        MaterialButton accept=button("Accept and continue",()->{if(!read.isChecked()||!agree.isChecked())return;String owner=uid;io.execute(()->{try{new CloudApi(owner).acceptTerms();runOnUiThread(()->{if(uid.equals(owner))load();});}catch(Exception e){report(e);}});});accept.setEnabled(false);read.setOnCheckedChangeListener((b,c)->accept.setEnabled(c&&agree.isChecked()));agree.setOnCheckedChangeListener((b,c)->accept.setEnabled(c&&read.isChecked()));content.addView(accept);status();
    }
    private void load(){if(uid.isEmpty())return;String owner=uid,chosen=workspace;long serial=++loadSerial;loading=true;updateButtons();
        io.execute(()->{try{
            CloudApi api=new CloudApi(owner);JSONArray all=api.get("/v2/workspaces").getJSONArray("workspaces");List<JSONObject> spaces=new ArrayList<>();for(int n=0;n<all.length();n++){JSONObject s=all.getJSONObject(n);if("paid".equals(s.optString("kind"))&&s.optBoolean("storageActive")&&s.optBoolean("provisioned"))spaces.add(s);}
            String effective=chosen;boolean found=chosen.equals("free");for(JSONObject entry:spaces)if(chosen.equals(entry.optString("id")))found=true;if(!found)effective="free";
            JSONObject config=null;List<JSONObject> list=new ArrayList<>();try{config=api.get(CloudApi.workspace(effective)+"/config");list=api.files(effective);}catch(CloudApi.Failure e){if(e.status!=404||!effective.equals("free"))throw e;}
            JSONObject cfg=config;List<JSONObject> loaded=list;String verifiedWorkspace=effective;runOnUiThread(()->{if(serial!=loadSerial||!owner.equals(uid))return;loading=false;activeLock=null;lockFiles.clear();lockFilesFor="";if(deletion==null||deletion.step!=AccountDeletion.Step.POLLING)deletion=null;workspace=verifiedWorkspace;rememberSpaces(spaces);getSharedPreferences("gd-settings",MODE_PRIVATE).edit().putString("workspace:"+uid,workspace).apply();files=loaded;if(deletion!=null&&deletion.step==AccountDeletion.Step.POLLING)return;showLibrary(spaces,cfg);});
        }catch(Exception e){runOnUiThread(()->{if(serial!=loadSerial||!owner.equals(uid))return;loading=false;if(e instanceof WorkspaceLocked locked){showLock(locked.lock);return;}updateButtons();say(e.getMessage());});}});
    }
    private void showLibrary(List<JSONObject> spaces,JSONObject cfg){
        boolean dataSaver=getPreferences(MODE_PRIVATE).getBoolean("data-saver",false);shell();TextView eyebrow=text("YOUR DIGITAL SPACE",9,true);eyebrow.setTextColor(accent);eyebrow.setLetterSpacing(.18f);content.addView(eyebrow);space(content,10);content.addView(text("My cloud",38,true));TextView subtitle=text("Everything you need. Nothing in your way.",13,false);subtitle.setTextColor(muted);content.addView(subtitle);space(content,20);
        List<String> ids=new ArrayList<>(List.of("free")),names=new ArrayList<>(List.of("Free · 2 GB"));for(JSONObject s:spaces){ids.add(s.optString("id"));names.add(s.optString("name"));}
        Spinner selected=new Spinner(this);ArrayAdapter<String> adapter=new ArrayAdapter<>(this,android.R.layout.simple_spinner_dropdown_item,names);selected.setAdapter(adapter);selected.setSelection(Math.max(0,ids.indexOf(workspace)));selected.setEnabled(!workBusy&&!loading);content.addView(selected,new LinearLayout.LayoutParams(-1,dp(48)));selected.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener(){public void onNothingSelected(android.widget.AdapterView<?> p){}public void onItemSelected(android.widget.AdapterView<?> p,View v,int pos,long id){if(!ids.get(pos).equals(workspace)){workspace=ids.get(pos);getSharedPreferences("gd-settings",MODE_PRIVATE).edit().putString("workspace:"+uid,workspace).apply();query="";load();}}});
        LinearLayout panel=inside(card(content));
        if(cfg==null){panel.addView(text("Start with 2 GB, on us.",24,true));space(panel,12);panel.addView(text("Private storage with resumable transfers and integrity checks. No payment required.",14,false));space(panel,16);panel.addView(button("Create free workspace",()->{String owner=uid;io.execute(()->{try{new CloudApi(owner).request("/v1/free","POST",new JSONObject().put("name","My Free Cloud"));runOnUiThread(this::load);}catch(Exception e){report(e);}});}));status();say("Create your free workspace to begin.");return;}
        long used=cfg.optLong("usedBytes"),quota=cfg.optLong("quotaBytes");panel.addView(text(Formatter.formatFileSize(this,used)+" / "+Formatter.formatFileSize(this,quota),24,true));space(panel,8);TextView label=text("STORAGE USED / TOTAL",9,true);label.setTextColor(muted);panel.addView(label);space(panel,15);LinearProgressIndicator capacity=new LinearProgressIndicator(this);capacity.setIndicatorColor(accent);capacity.setProgressCompat((int)Math.min(100,100*(used+cfg.optLong("reservedBytes"))/Math.max(1,quota)),false);panel.addView(capacity);space(panel,12);panel.addView(text("Up to "+Math.min(4,cfg.optJSONObject("transfer").optInt("workers",1))+" parallel transfers on this device",12,false));
        content.addView(text("Applications, files & folders",20,true));space(content,8);
        content.addView(text("Choose app packages such as APKs, any files, or a complete folder. Android installs compatible APKs with your approval. Desktop and iOS applications are stored for their own devices.",12,false));
        upload=button("↑  Upload files / applications",()->picker.launch(new String[]{"*/*"}));content.addView(upload);
        folderUpload=button("↑  Upload complete folder",()->folderPicker.launch(null));content.addView(folderUpload);
        removeOriginals=new CheckBox(this);removeOriginals.setText("Remove selected originals after verified upload and complete restore check");content.addView(removeOriginals);
        CheckBox applicationFilter=new CheckBox(this);applicationFilter.setText("Show Applications");applicationFilter.setChecked(applicationsOnly);applicationFilter.setOnCheckedChangeListener((view,checked)->{applicationsOnly=checked;drawFiles();});content.addView(applicationFilter);
        saver=new SwitchMaterial(this);saver.setText("Data saver");saver.setChecked(dataSaver);saver.setOnCheckedChangeListener((v,checked)->getPreferences(MODE_PRIVATE).edit().putBoolean("data-saver",checked).apply());content.addView(saver);
        transferProgress=new LinearProgressIndicator(this);transferProgress.setIndicatorColor(accent);transferProgress.setVisibility(workBusy?View.VISIBLE:View.GONE);content.addView(transferProgress);transferText=text("",12,false);transferText.setTextColor(muted);content.addView(transferText);pause=button("Pause transfer",()->WorkManager.getInstance(this).cancelUniqueWork("GenDragoonTransfer"));pause.setVisibility(workBusy?View.VISIBLE:View.GONE);content.addView(pause);
        LinearLayout controls=new LinearLayout(this);controls.setGravity(Gravity.CENTER_VERTICAL);EditText search=new EditText(this);search.setHint("Find a file…");search.setText(query);search.setSingleLine(true);search.setTextSize(14);controls.addView(search,new LinearLayout.LayoutParams(0,dp(52),1));refresh=button("Refresh",this::load);controls.addView(refresh);content.addView(controls);search.addTextChangedListener(new TextWatcher(){public void beforeTextChanged(CharSequence s,int start,int count,int after){}public void onTextChanged(CharSequence s,int start,int before,int count){query=s.toString();pageSize=100;drawFiles();}public void afterTextChanged(Editable e){}});
        MaterialButton sortButton=button("Sort files",()->new MaterialAlertDialogBuilder(this).setTitle("Sort files").setItems(new String[]{"Name A–Z","Largest first","Smallest first"},(d,which)->{sort=which==1?"largest":which==2?"smallest":"name";drawFiles();}).show());sortButton.setBackgroundTintList(ColorStateList.valueOf(surface));sortButton.setTextColor(accent);content.addView(sortButton);
        fileList=vertical();content.addView(fileList);drawFiles();status();say("Your private files and application packages are ready.");space(content,12);TextView help=text("Uploads run as a visible background transfer. If paused, choose the same file to resume. Restored files can be shared to other apps.",11,false);help.setTextColor(muted);content.addView(help);updateButtons();
    }
    private void drawFiles(){if(fileList==null)return;fileList.removeAllViews();List<JSONObject> visible=new ArrayList<>();for(JSONObject f:files)if((!applicationsOnly||SelectionArchive.isApplication(f.optString("name")))&&f.optString("name").toLowerCase(Locale.ROOT).contains(query.toLowerCase(Locale.ROOT)))visible.add(f);
        visible.sort((a,b)->sort.equals("largest")?Long.compare(b.optLong("sizeBytes"),a.optLong("sizeBytes")):sort.equals("smallest")?Long.compare(a.optLong("sizeBytes"),b.optLong("sizeBytes")):a.optString("name").compareToIgnoreCase(b.optString("name")));
        if(visible.isEmpty()){TextView empty=text(files.isEmpty()?"No cloud files yet.\nUpload your first file to get started.":"No matching files.",16,false);empty.setGravity(Gravity.CENTER);empty.setTextColor(muted);empty.setPadding(0,dp(35),0,dp(35));fileList.addView(empty);return;}
        for(JSONObject file:visible.subList(0,Math.min(pageSize,visible.size()))){LinearLayout p=inside(card(fileList));TextView title=text(file.optString("name"),14,true);title.setMaxLines(3);p.addView(title);space(p,7);TextView size=text(Formatter.formatFileSize(this,file.optLong("sizeBytes")),11,false);size.setTextColor(muted);p.addView(size);space(p,8);LinearLayout actions=new LinearLayout(this);actions.setGravity(Gravity.END);
            MaterialButton restore=button("Restore",()->enqueueDownload(file));restore.setEnabled(!workBusy);actions.addView(restore);
            MaterialButton remove=button("Delete",()->new MaterialAlertDialogBuilder(this).setTitle("Delete cloud copy?").setMessage("Remove "+file.optString("name")+" from cloud storage? Local copies are unchanged.").setNegativeButton("Cancel",null).setPositiveButton("Delete",(d,w)->{String owner=uid,where=workspace;io.execute(()->{try{new CloudApi(owner).request(CloudApi.workspace(where)+"/files/"+file.getString("id"),"DELETE",(JSONObject)null);runOnUiThread(()->{if(owner.equals(uid))load();});}catch(Exception e){report(e);}});}).show());remove.setEnabled(!workBusy);remove.setBackgroundTintList(ColorStateList.valueOf(surface));remove.setTextColor(Color.rgb(222,172,188));actions.addView(remove);p.addView(actions);
        }
        if(visible.size()>pageSize)fileList.addView(button("Show more files",()->{pageSize+=100;drawFiles();}));
    }
    private void chooseUpload(List<Uri> uris,boolean folder){
        if(uris.isEmpty()||uid.isEmpty()||workBusy||!CloudSignals.allowsTransfer("PUT",activeLock!=null))return;
        if(removeOriginals!=null&&removeOriginals.isChecked())new MaterialAlertDialogBuilder(this).setTitle("Upload and remove originals?").setMessage("The "+uris.size()+" selected items will be removed only after a complete cloud read-back and archive restore check. Some document providers delete permanently.").setNegativeButton("Cancel",null).setNeutralButton("Keep originals",(d,w)->queueUploads(uris,folder,false)).setPositiveButton("Verify then remove",(d,w)->queueUploads(uris,folder,true)).show();
        else queueUploads(uris,folder,false);
    }
    private void queueUploads(List<Uri> uris,boolean folder,boolean remove){
        if(workBusy||uid.isEmpty()||!CloudSignals.allowsTransfer("PUT",activeLock!=null))return;List<OneTimeWorkRequest> jobs=new ArrayList<>();
        for(Uri uri:uris){
            try{getContentResolver().takePersistableUriPermission(uri,Intent.FLAG_GRANT_READ_URI_PERMISSION|(remove?Intent.FLAG_GRANT_WRITE_URI_PERMISSION:0));}
            catch(SecurityException e){try{getContentResolver().takePersistableUriPermission(uri,Intent.FLAG_GRANT_READ_URI_PERMISSION);}catch(SecurityException denied){say("This provider cannot grant resumable access. Save the selection in Files or Downloads first.");return;}}
            jobs.add(request("upload",new Data.Builder().putString("uri",uri.toString()).putBoolean("folder",folder).putBoolean("removeOriginal",remove)));
        }
        WorkContinuation chain=WorkManager.getInstance(this).beginUniqueWork("GenDragoonTransfer",ExistingWorkPolicy.KEEP,jobs.get(0));for(int i=1;i<jobs.size();i++)chain=chain.then(jobs.get(i));chain.enqueue();workBusy=true;updateButtons();
        if(removeOriginals!=null)removeOriginals.setChecked(false);if(Build.VERSION.SDK_INT>=33)notifications.launch(Manifest.permission.POST_NOTIFICATIONS);
    }
    private OneTimeWorkRequest request(String action,Data.Builder input){return request(action,input,workspace);}
    private OneTimeWorkRequest request(String action,Data.Builder input,String where){return new OneTimeWorkRequest.Builder(TransferWorker.class).setInputData(input.putString("uid",uid).putString("workspace",where).putString("action",action).putBoolean("dataSaver",saver!=null&&saver.isChecked()).build()).setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).addTag("GenDragoon").build();}
    private void enqueueDownload(JSONObject file){enqueueDownload(file,workspace);}
    private void enqueueDownload(JSONObject file,String where){if(workBusy||where==null||where.isEmpty()||!CloudSignals.allowsTransfer("GET",activeLock!=null))return;OneTimeWorkRequest work=request("download",new Data.Builder().putString("file",file.toString()),where);WorkManager.getInstance(this).enqueueUniqueWork("GenDragoonTransfer",ExistingWorkPolicy.KEEP,work);workBusy=true;updateButtons();if(Build.VERSION.SDK_INT>=33)notifications.launch(Manifest.permission.POST_NOTIFICATIONS);}
    private void updateButtons(){boolean uploads=!workBusy&&!loading&&CloudSignals.allowsTransfer("PUT",activeLock!=null);if(upload!=null)upload.setEnabled(uploads);if(folderUpload!=null)folderUpload.setEnabled(uploads);if(removeOriginals!=null)removeOriginals.setEnabled(uploads);if(refresh!=null)refresh.setEnabled(!workBusy&&!loading);if(saver!=null)saver.setEnabled(!workBusy);if(pause!=null)pause.setVisibility(workBusy?View.VISIBLE:View.GONE);if(transferProgress!=null)transferProgress.setVisibility(workBusy?View.VISIBLE:View.GONE);}
    private void showSaved(String path){if(path==null||uid.isEmpty())return;File file=new File(path);try{String allowed=new File(getFilesDir(),"exports/"+CloudApi.sha(uid.getBytes(StandardCharsets.UTF_8))).getCanonicalPath()+File.separator;if(!file.getCanonicalPath().startsWith(allowed)||!file.isFile())return;}catch(Exception e){say("Restored file is unavailable.");return;}
        new MaterialAlertDialogBuilder(this).setTitle("File restored").setNeutralButton(file.getName().toLowerCase(Locale.ROOT).endsWith(".apk")?"Install APK":null,(dialog,which)->installPackage(file)).setMessage(file.getName()+" is verified and ready."+(SelectionArchive.isApplication(file.getName())?" Application packages run only on compatible platforms. Android installations are managed by the system, separately from the GenDragoon cache.":"")).setNegativeButton("Done",null).setPositiveButton("Share or save",(dialog,which)->{Uri uri=FileProvider.getUriForFile(this,getPackageName()+".files",file);Intent share=new Intent(Intent.ACTION_SEND).setType("application/octet-stream").putExtra(Intent.EXTRA_STREAM,uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);share.setClipData(ClipData.newRawUri(file.getName(),uri));startActivity(Intent.createChooser(share,"Save or open file"));}).show();
    }
    private void installPackage(File file){
        if(!file.getName().toLowerCase(Locale.ROOT).endsWith(".apk"))return;
        if(!getPackageManager().canRequestPackageInstalls()){
            new MaterialAlertDialogBuilder(this).setTitle("Allow Android package installation?").setMessage("Android requires you to allow this source. Return here and choose Install APK again after changing the system setting.").setNegativeButton("Cancel",null).setPositiveButton("Open system setting",(d,w)->startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:"+getPackageName())))).show();return;
        }
        Uri uri=FileProvider.getUriForFile(this,getPackageName()+".files",file);
        Intent install=new Intent(Intent.ACTION_VIEW).setDataAndType(uri,"application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);install.setClipData(ClipData.newRawUri(file.getName(),uri));
        try{startActivity(install);}catch(ActivityNotFoundException e){say("No system package installer is available. Use Share or save to export this package.");}
    }
    private void resetApp(){
        if(workBusy){say("Pause or finish transfers before resetting.");return;}
        new MaterialAlertDialogBuilder(this).setTitle("Reset App?").setMessage("Clear local settings and transfer cache. Cloud files, exported documents and Android-installed applications stay in place.").setNegativeButton("Cancel",null).setPositiveButton("Reset",(d,w)->{
            String owner=uid;loading=true;updateButtons();io.execute(()->{try{
                File root=getCacheDir().getCanonicalFile();for(String child:List.of("gd-inputs","gd-downloads","gd-folder-inputs")){File selected=new File(root,child);if(selected.exists())clearManaged(selected,root);}
                getSharedPreferences("gd-transfer-checkpoints",MODE_PRIVATE).edit().clear().commit();getSharedPreferences("gd-settings",MODE_PRIVATE).edit().remove("workspace:"+owner).commit();getPreferences(MODE_PRIVATE).edit().remove("data-saver").commit();
                runOnUiThread(()->{loading=false;if(owner.equals(uid)){workspace="free";load();}});
            }catch(Exception error){runOnUiThread(()->{loading=false;updateButtons();say(error.getMessage());});}});
        }).show();
    }
    private static void clearManaged(File file,File root)throws IOException{
        if(!file.getCanonicalPath().startsWith(root.getCanonicalPath()+File.separator))throw new IOException("Unsafe cache path; reset stopped.");
        if(file.isDirectory()){File[] children=file.listFiles();if(children==null)throw new IOException("Cache cannot be listed.");for(File child:children)clearManaged(child,root);}if(!file.delete())throw new IOException("A cache file could not be removed.");
    }
    private void account(){
        FirebaseUser user=auth.getCurrentUser();if(user==null)return;
        LinearLayout box=vertical();box.setPadding(dp(8),dp(4),dp(8),dp(4));
        box.addView(button("About GenDragoon",()->new MaterialAlertDialogBuilder(this).setTitle("GenDragoon").setMessage("Cloud files, folders and application packages. Your workspace quotas and transfer limits are verified by the server. Mobile updates are distributed through the app store. Android manages installed apps independently of the GenDragoon cache.").setPositiveButton("Done",null).show()));
        box.addView(button("Reset App",this::resetApp));
        box.addView(button("Privacy Notice",()->startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse(CloudApi.ORIGIN+"/mobile/privacy.txt")))));
        if(ByoFeature.showInSettings())box.addView(button("Bring-your-own storage",this::showByo));
        androidx.appcompat.app.AlertDialog[] shown=new androidx.appcompat.app.AlertDialog[1];
        MaterialButton delete=button("Delete account",()->{if(workBusy||shown[0]==null)return;shown[0].dismiss();deletionEpoch++;foreignSession=false;deletionOwnerUid=user.getUid();deletionOwnerEmail=user.getEmail()==null?"":user.getEmail();deletionOwnerGoogleId=googleProviderId(user);deletionSignInStarted=false;wiping=false;holdAuthNavigation=true;DeletionReceipt saved=DeletionReceiptVault.read(this);if(saved!=null){deletionOwnerUid=DeletionSignIn.ownerUid(saved,deletionOwnerUid);deletion=AccountDeletion.resume(saved);advanceDeletion();return;}deletion=new AccountDeletion();showDeleteAccount();});
        delete.setEnabled(!workBusy);delete.setBackgroundTintList(ColorStateList.valueOf(Color.rgb(120,32,48)));delete.setTextColor(Color.WHITE);box.addView(delete);
        box.addView(button("Sign out",()->{WorkManager.getInstance(this).cancelUniqueWork("GenDragoonTransfer");auth.signOut();}));
        shown[0]=new MaterialAlertDialogBuilder(this).setTitle(user.getEmail()==null?"Account":user.getEmail()).setView(box).setNegativeButton("Done",null).create();shown[0].show();
    }
    private void rememberSpaces(List<JSONObject> spaces){
        knownSpaces.clear();knownSpaces.add(new WorkspaceLock.Item("free","Free",null));
        for(JSONObject space:spaces)knownSpaces.add(new WorkspaceLock.Item(space.optString("id"),space.optString("name"),null));
    }
    private void showLock(WorkspaceLock lock){
        WorkspaceLock resolved=(lock==null?new WorkspaceLock(List.of(),""):lock).named(knownSpaces);
        if(deletion!=null&&deletion.step==AccountDeletion.Step.POLLING){activeLock=resolved;return;}
        activeLock=resolved;loadSerial++;deletion=null;shell();
        content.addView(text("Workspaces locked",30,true));space(content,12);
        TextView body=text("Your files are still readable and downloadable. Uploads are paused until you delete or merge workspaces down to your plan limit.",15,false);body.setTextColor(muted);content.addView(body);
        String reason=activeLock.reasonText();if(!reason.isEmpty()){space(content,10);content.addView(text(reason,16,true));}
        space(content,8);content.addView(text(activeLock.overByText(),16,true));
        String detail=activeLock.detailText();if(!detail.isEmpty()){space(content,8);content.addView(text(detail,15,false));}
        String choose=activeLock.chooseMessage();if(!choose.isEmpty()){space(content,10);content.addView(text(choose,16,true));}
        String issues=activeLock.issueSummary();if(!issues.isEmpty()){space(content,10);content.addView(text(issues,14,true));}
        if(knownSpaces.isEmpty()&&(activeLock.overBy>0||!activeLock.unpaidIds.isEmpty()))fetchLockNames();
        space(content,8);TextView note=text("Duplicates are kept as name (from <source>).",12,false);note.setTextColor(muted);content.addView(note);space(content,8);
        if(activeLock.workspaces.isEmpty()&&detail.isEmpty())content.addView(text("The server did not include a workspace list.",14,false));
        for(WorkspaceLock.Item item:activeLock.workspaces){
            LinearLayout panel=inside(card(content));panel.addView(text(item.label(),16,true));space(panel,8);
            LinearLayout actions=new LinearLayout(this);
            if(!activeLock.requiresPayment()){
                MaterialButton remove=button(WorkspaceLock.ACTION_DELETE,()->confirmDeleteWorkspace(item));remove.setEnabled(item.id!=null&&!workBusy);remove.setBackgroundTintList(ColorStateList.valueOf(Color.rgb(120,32,48)));remove.setTextColor(Color.WHITE);actions.addView(remove);
                MaterialButton merge=button(WorkspaceLock.ACTION_MERGE,()->chooseMerge(item));merge.setEnabled(item.id!=null&&!workBusy);merge.setBackgroundTintList(ColorStateList.valueOf(surface));merge.setTextColor(accent);actions.addView(merge);
            }
            MaterialButton download=button(WorkspaceLock.ACTION_DOWNLOAD,()->listWorkspaceFiles(item));download.setEnabled(item.id!=null&&!workBusy&&CloudSignals.allowsTransfer("GET",true));actions.addView(download);
            panel.addView(actions);
            if(item.id!=null&&item.id.equals(lockFilesFor)){
                if(lockFiles.isEmpty()){space(panel,8);panel.addView(text("No files to download in this workspace.",13,false));}
                for(JSONObject file:lockFiles){space(panel,8);panel.addView(text(file.optString("name"),14,false));MaterialButton restore=button("Download",()->enqueueDownload(file,item.id));restore.setEnabled(!workBusy);panel.addView(restore);}
            }
        }
        space(content,12);content.addView(button("Check again",this::load));status();
    }
    private void confirmDeleteWorkspace(WorkspaceLock.Item item){
        if(item.id==null)return;
        new MaterialAlertDialogBuilder(this).setTitle("Delete workspace?").setMessage("This permanently deletes the hosted workspace \""+item.label()+"\" and its files. Bring-your-own storage is not changed.").setNegativeButton("Cancel",null).setPositiveButton("Delete workspace",(d,w)->{
            String owner=uid,id=item.id;io.execute(()->{try{new CloudApi(owner).deleteWorkspace(id);runOnUiThread(()->{if(owner.equals(uid))load();});}catch(Exception e){report(e);}});
        }).show();
    }
    private void chooseMerge(WorkspaceLock.Item source){
        List<WorkspaceLock.Item> targets=new ArrayList<>();List<String> labels=new ArrayList<>();
        for(WorkspaceLock.Item candidate:activeLock.workspaces)if(candidate.id!=null&&!candidate.id.equals(source.id)){targets.add(candidate);labels.add(candidate.label());}
        if(targets.isEmpty()){new MaterialAlertDialogBuilder(this).setTitle("Merge workspaces").setMessage(AccountActions.mergeUnavailable(source.name)).setPositiveButton("OK",null).show();return;}
        new MaterialAlertDialogBuilder(this).setTitle("Merge into").setItems(labels.toArray(new String[0]),(d,which)->{
            WorkspaceLock.Item target=targets.get(which);
            String sourceName=source.name==null||source.name.isEmpty()?source.id:source.name;
            String owner=uid;
            new MaterialAlertDialogBuilder(this).setTitle("Merge workspaces").setMessage(AccountActions.mergeUnavailable(sourceName)).setNegativeButton("Cancel",null).setPositiveButton("Merge",(dialog,index)->io.execute(()->{try{new CloudApi(owner).mergeWorkspace(source.id,target.id,sourceName);runOnUiThread(()->{if(owner.equals(uid))load();});}catch(Exception error){report(error);}})).show();
        }).setNegativeButton("Cancel",null).show();
    }
    private void listWorkspaceFiles(WorkspaceLock.Item item){
        if(item.id==null||!CloudSignals.allowsTransfer("GET",true))return;
        String owner=uid,id=item.id;io.execute(()->{try{
            List<JSONObject> listed=new CloudApi(owner).files(id);
            runOnUiThread(()->{if(!owner.equals(uid)||activeLock==null)return;lockFiles.clear();lockFiles.addAll(listed);lockFilesFor=id;showLock(activeLock);});
        }catch(Exception e){report(e);}});
    }
    private void showDeleteAccount(){
        if(deletion==null)return;loadSerial++;shell();
        content.addView(text("Delete account",30,true));space(content,12);
        switch(deletion.step){
            case EXPLAIN -> {
                content.addView(text("This deletes your account, all hosted workspaces and their files. Subscriptions are cancelled. Bring-your-own storage is not changed.",15,false));
                space(content,16);content.addView(button("Continue",()->{deletion.continueFromExplain();showDeleteAccount();}));
                space(content,8);content.addView(button("Cancel",this::cancelDeletion));
            }
            case CONFIRM -> {
                content.addView(text("Type DELETE to confirm. You will sign in with Google again immediately before the account is deleted.",15,false));
                space(content,12);EditText phrase=new EditText(this);phrase.setHint("Type DELETE");phrase.setSingleLine(true);content.addView(phrase);
                MaterialButton confirm=button("Delete account",()->{if(deletion.confirmPhrase(phrase.getText().toString())){deletionSignInStarted=false;showDeleteAccount();}});
                confirm.setEnabled(false);confirm.setBackgroundTintList(ColorStateList.valueOf(Color.rgb(120,32,48)));confirm.setTextColor(Color.WHITE);
                phrase.addTextChangedListener(new TextWatcher(){public void beforeTextChanged(CharSequence s,int a,int b,int c){}public void onTextChanged(CharSequence s,int a,int b,int c){confirm.setEnabled(AccountDeletion.CONFIRM_PHRASE.equals(s.toString()));}public void afterTextChanged(Editable e){}});
                space(content,12);content.addView(confirm);space(content,8);content.addView(button("Cancel",this::cancelDeletion));
            }
            case REAUTH -> {
                content.addView(text(deletion.message==null?"Sign in again. The server only accepts a sign-in from the last 5 minutes.":deletion.message,15,false));
                space(content,16);content.addView(button("Sign in again",this::beginDeletionSignIn));
                space(content,8);content.addView(button("Cancel",this::cancelDeletion));
                if(!deletionSignInStarted){deletionSignInStarted=true;beginDeletionSignIn();}
            }
            case DELETING, POLLING -> {content.addView(text(deletion.step==AccountDeletion.Step.POLLING?"Deleting your account…":"Starting deletion…",15,false));}
            case DONE -> {
                if(wiping)content.addView(text("Removing this device's copy of your account…",15,false));
                else{content.addView(text(deletion.message==null?"Local data could not be removed.":deletion.message,15,false));space(content,12);content.addView(button("Retry",this::finishDeletionLocally));}
            }
            case FAILED -> {
                content.addView(text(deletion.message==null?"Account deletion did not finish. You can retry.":deletion.message,15,false));
                if(deletion.offersRetry()){space(content,12);content.addView(button("Retry",()->{deletion.retry();if(deletion.step==AccountDeletion.Step.POLLING){advanceDeletion();return;}deletionSignInStarted=false;showDeleteAccount();}));}
                if(deletion.showSupport){space(content,8);MaterialButton support=button("Contact support",()->{try{startActivity(new Intent(Intent.ACTION_SENDTO,Uri.parse(SupportContact.mailto(deletion.jobId))));}catch(Exception ignored){}});support.setContentDescription("deletion-support");content.addView(support);}
                if(deletion.canDismiss()){space(content,8);content.addView(button("Dismiss",this::dismissDeletionError));}
                else{space(content,8);content.addView(button("Cancel",this::cancelDeletion));}
            }
            case SIGNED_OUT -> {
                if(deletion.keepsPolling())content.addView(text("Deleting your account…",15,false));
                else{
                    content.addView(text("Sign in again to continue.",15,false));
                    space(content,16);content.addView(button("Return to sign-in",this::leaveDeletionSignedOut));
                }
            }
            case WIPED -> {
                content.addView(text("Your account has been deleted.",18,true));space(content,8);
                content.addView(text("Hosted workspaces and this device's copy of your data have been erased. Bring-your-own storage was not changed.",15,false));
                space(content,16);content.addView(button("Return to sign-in",()->{holdAuthNavigation=false;deletion=null;wiping=false;activeLock=null;showLogin();}));
            }
        }
        status();
    }
    private void cancelDeletion(){deletionEpoch++;deletionAuthBusy=false;wiping=false;boolean openLibrary=DeletionSignIn.cancelOpensLibrary(foreignSession);foreignSession=false;holdAuthNavigation=false;deletion=null;if(openLibrary)load();else showLogin();}
    private void dismissDeletionError(){
        if(deletion==null||!deletion.dismissError())return;
        DeletionReceiptVault.clear(this);
        deletionEpoch++;deletionAuthBusy=false;wiping=false;boolean openLibrary=DeletionSignIn.cancelOpensLibrary(foreignSession);foreignSession=false;holdAuthNavigation=false;deletion=null;if(openLibrary)load();else showLogin();
    }
    private void beginDeletionSignIn(){
        if(deletionAuthBusy||deletion==null||deletion.step!=AccountDeletion.Step.REAUTH)return;
        deletionAuthBusy=true;holdAuthNavigation=true;int epoch=deletionEpoch;
        GetGoogleIdOption option=new GetGoogleIdOption.Builder().setServerClientId(getString(R.string.default_web_client_id)).setFilterByAuthorizedAccounts(false).setAutoSelectEnabled(false).build();
        credentials.getCredentialAsync(this,new GetCredentialRequest.Builder().addCredentialOption(option).build(),new CancellationSignal(),command->main.post(command),new CredentialManagerCallback<GetCredentialResponse,GetCredentialException>(){
            @Override public void onResult(GetCredentialResponse result){
                if(epoch!=deletionEpoch||deletion==null){deletionAuthBusy=false;return;}
                try{Credential c=result.getCredential();if(!(c instanceof CustomCredential)||!GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(c.getType()))throw new IllegalStateException("Unexpected Google credential.");
                    GoogleIdTokenCredential google=GoogleIdTokenCredential.createFrom(c.getData());
                    String googleEmail=DeletionSignIn.claim(google.getIdToken(),"email");
                    if(googleEmail==null)googleEmail="";
                    String googleId=google.getId()==null?"":google.getId();
                    if(DeletionSignIn.blocksCredential(deletionOwnerGoogleId,deletionOwnerEmail,googleId,googleEmail)){
                        deletion.rejectDifferentAccount(deletionOwnerUid.isEmpty()?"saved-account":deletionOwnerUid,"blocked-before-sign-in",deletionOwnerEmail,googleEmail);
                        deletionAuthBusy=false;showDeleteAccount();return;
                    }
                    auth.signInWithCredential(GoogleAuthProvider.getCredential(google.getIdToken(),null)).addOnCompleteListener(task->{
                        if(epoch!=deletionEpoch||deletion==null){deletionAuthBusy=false;return;}
                        if(!task.isSuccessful()||auth.getCurrentUser()==null){deletionAuthBusy=false;deletion.message=task.getException()==null?"Sign-in failed.":task.getException().getMessage();showDeleteAccount();return;}
                        FirebaseUser signed=auth.getCurrentUser();
                        if(deletion.rejectDifferentAccount(deletionOwnerUid,signed.getUid(),deletionOwnerEmail,signed.getEmail())){foreignSession=true;holdAuthNavigation=true;auth.signOut();deletionAuthBusy=false;showDeleteAccount();return;}
                        signed.getIdToken(false).addOnCompleteListener(tokenTask->{
                            deletionAuthBusy=false;if(epoch!=deletionEpoch||deletion==null)return;
                            if(!tokenTask.isSuccessful()||tokenTask.getResult()==null||tokenTask.getResult().getToken()==null){deletion.message="Sign in again. The server only accepts a sign-in from the last 5 minutes.";showDeleteAccount();return;}
                            String jwt=tokenTask.getResult().getToken();Long authTime=CloudSignals.authTimeMillis(jwt);
                            if(!deletion.acceptFreshSignIn(authTime==null?0L:authTime,System.currentTimeMillis())){showDeleteAccount();return;}
                            if(deletion.step==AccountDeletion.Step.POLLING||!deletion.allowsDelete()){advanceDeletion();return;}
                            sendDelete(jwt,epoch);
                        });
                    });
                }catch(Exception error){deletionAuthBusy=false;if(deletion!=null)deletion.message=error.getMessage();showDeleteAccount();}
            }
            @Override public void onError(@NonNull GetCredentialException error){deletionAuthBusy=false;if(epoch!=deletionEpoch||deletion==null)return;deletion.message=error.getMessage()==null?"Google sign-in was cancelled or unavailable.":error.getMessage();showDeleteAccount();}
        });
    }
    private void sendDelete(String jwt,int epoch){
        if(deletion==null||!deletion.allowsDelete())return;String owner=uid;
        io.execute(()->{
            AccountDeletion.Exchange exchange=AccountDeletion.exchange((method,path,payload,authorization)->new CloudApi(owner).deleteAccountCall(jwt),"DELETE","/v2/account",AccountActions.CONFIRM_BODY,"Bearer "+jwt);
            runOnUiThread(()->applyDelete(exchange,epoch));
        });
    }
    private void applyDelete(AccountDeletion.Exchange exchange,int epoch){
        if(epoch!=deletionEpoch||deletion==null)return;
        deletion.completeDelete(exchange);
        AccountActions.HttpBody body=deletion.lastBody;
        if(body!=null&&body.status==423&&CloudSignals.CODE_LOCK.equals(body.error)){noteLockDuringDeletion(WorkspaceLock.decode(body.raw));return;}
        persistReceipt();advanceDeletion();
    }
    private void persistReceipt(){
        if(deletion==null)return;
        DeletionReceipt receipt=deletion.receipt();
        if(receipt!=null&&deletion.step==AccountDeletion.Step.POLLING){
            DeletionReceipt stored=DeletionReceipt.of(receipt.jobId,receipt.statusToken,deletionOwnerUid);
            if(stored!=null)DeletionReceiptVault.save(this,stored);
        }
    }
    private void noteLockDuringDeletion(WorkspaceLock lock){
        activeLock=(lock==null?new WorkspaceLock(List.of(),""):lock).named(knownSpaces);
        if(deletion!=null&&deletion.step==AccountDeletion.Step.POLLING)return;
        showLock(lock);
    }
    private void fetchLockNames(){
        if(lockNamesRequested||uid.isEmpty())return;lockNamesRequested=true;String owner=uid;
        io.execute(()->{try{
            JSONArray all=new CloudApi(owner).get("/v2/workspaces").getJSONArray("workspaces");
            List<JSONObject> spaces=new ArrayList<>();for(int n=0;n<all.length();n++)spaces.add(all.getJSONObject(n));
            runOnUiThread(()->{if(!owner.equals(uid)||activeLock==null)return;rememberSpaces(spaces);showLock(activeLock);});
        }catch(Exception error){report(error);}});
    }
    private static String googleProviderId(FirebaseUser user){
        if(user==null)return "";
        for(com.google.firebase.auth.UserInfo info:user.getProviderData()){
            if(info!=null&&"google.com".equals(info.getProviderId())&&info.getUid()!=null&&!info.getUid().isEmpty())return info.getUid();
        }
        return "";
    }
    private void showByo(){
        if(!ByoFeature.showInSettings())return;
        LinearLayout box=vertical();box.setPadding(dp(8),dp(4),dp(8),dp(4));
        box.addView(text("S3-compatible storage. Keys stay on this device.",14,false));
        EditText endpoint=new EditText(this);endpoint.setHint("Endpoint");endpoint.setSingleLine(true);box.addView(endpoint);
        EditText bucket=new EditText(this);bucket.setHint("Bucket");bucket.setSingleLine(true);box.addView(bucket);
        EditText access=new EditText(this);access.setHint("Access key");access.setSingleLine(true);box.addView(access);
        EditText secret=new EditText(this);secret.setHint("Secret key");secret.setSingleLine(true);box.addView(secret);
        for(String provider:List.of("SFTP","Azure","WebDAV")){TextView row=text(provider+" · "+ByoMessages.COMING_SOON,14,false);row.setEnabled(false);row.setTextColor(muted);box.addView(row);}
        new MaterialAlertDialogBuilder(this).setTitle("Bring-your-own storage").setView(box).setNegativeButton("Cancel",null).setPositiveButton("Save on this device",(d,w)->{
            try{ByoSecretStore.save(this,endpoint.getText().toString(),bucket.getText().toString(),access.getText().toString(),secret.getText().toString());say("S3-compatible keys are stored on this device.");}
            catch(Exception error){say(error.getMessage()==null?"Keys could not be saved on this device.":error.getMessage());}
        }).show();
    }
    private void advanceDeletion(){
        if(deletion==null)return;
        if(deletion.step==AccountDeletion.Step.REAUTH)deletionSignInStarted=false;
        if(deletion.dropReceipt&&!deletion.requestsWipe())DeletionReceiptVault.clear(this);
        if(deletion.clearSession){deletion.clearSession=false;holdAuthNavigation=true;if(auth.getCurrentUser()!=null)auth.signOut();}
        if(deletion.step==AccountDeletion.Step.SIGNED_OUT&&!deletion.keepsPolling()){leaveDeletionSignedOut();return;}
        if(deletion.keepsPolling()){
            if(deletion.exhausted()){deletion.fail("Account deletion is still running. You can retry.");showDeleteAccount();return;}
            long delay=deletion.nextPollDelayMillis();int epoch=deletionEpoch;showDeleteAccount();main.postDelayed(()->io.execute(()->pollOnce(epoch)),delay);return;
        }
        if(deletion.step==AccountDeletion.Step.DONE){finishDeletionLocally();return;}
        showDeleteAccount();
    }
    private void pollOnce(int epoch){
        if(epoch!=deletionEpoch||deletion==null||!deletion.keepsPolling())return;
        String path=deletion.statusPath,token=deletion.statusToken,owner=uid;
        AccountDeletion.Exchange exchange=AccountDeletion.exchange((method,route,payload,authorization)->new CloudApi(owner).pollDeletion(path,token),"GET",path,null,"Bearer "+token);
        runOnUiThread(()->{
            if(epoch!=deletionEpoch||deletion==null||!deletion.keepsPolling())return;
            deletion.completePoll(exchange);
            AccountActions.HttpBody body=deletion.lastBody;
            if(body!=null&&body.status==423&&CloudSignals.CODE_LOCK.equals(body.error))activeLock=WorkspaceLock.decode(body.raw).named(knownSpaces);
            advanceDeletion();
        });
    }
    private void leaveDeletionSignedOut(){holdAuthNavigation=false;deletionEpoch++;deletionAuthBusy=false;wiping=false;deletion=null;activeLock=null;auth.signOut();}
    private void finishDeletionLocally(){
        if(wiping||deletion==null||!deletion.requestsWipe())return;
        wiping=true;holdAuthNavigation=true;deletionEpoch++;showDeleteAccount();
        io.execute(()->{try{eraseAccountData();runOnUiThread(()->{wiping=false;if(deletion!=null)deletion.noteWiped();showDeleteAccount();});}catch(Exception error){runOnUiThread(()->{wiping=false;if(deletion!=null)deletion.message=error.getMessage()==null?"Local data could not be removed.":error.getMessage();showDeleteAccount();});}});
    }
    private void eraseAccountData()throws Exception{
        DeletionReceiptVault.clear(this);
        WorkManager.getInstance(this).cancelUniqueWork("GenDragoonTransfer");
        for(String name:LocalDataWipe.PREFERENCES)getSharedPreferences(name,MODE_PRIVATE).edit().clear().commit();
        getPreferences(MODE_PRIVATE).edit().clear().commit();
        File cache=getCacheDir().getCanonicalFile();
        for(String child:LocalDataWipe.CACHE_DIRS){File selected=new File(cache,child);if(selected.exists())clearManaged(selected,cache);}
        File exports=new File(getFilesDir(),LocalDataWipe.FILES_DIR);
        if(exports.exists())clearManaged(exports,getFilesDir().getCanonicalFile());
        KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
        for(String alias:LocalDataWipe.keystoreAliasesToDelete(Collections.list(store.aliases())))store.deleteEntry(alias);
        auth.signOut();
    }
}
