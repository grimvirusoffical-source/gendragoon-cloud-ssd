from pathlib import Path
import json,shutil
root=Path(__file__).resolve().parent
app=root/'app';main=app/'src/main';src=main/'java/app/gendragoon/cloudssd/mobile'
src.mkdir(parents=True,exist_ok=True)
for directory in ['res/values','res/drawable','res/xml','assets']:(main/directory).mkdir(parents=True,exist_ok=True)
(root/'settings.gradle').write_text('''pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }
rootProject.name = 'GenDragoonMobile'
include ':app'
''')
(root/'build.gradle').write_text("plugins { id 'com.android.application' version '8.13.2' apply false; id 'com.google.gms.google-services' version '4.4.4' apply false }\n")
(app/'build.gradle').write_text('''plugins { id 'com.android.application'; id 'com.google.gms.google-services' }
android {
 namespace 'app.gendragoon.cloudssd.mobile'
 compileSdk 36
 defaultConfig { applicationId 'app.gendragoon.cloudssd.mobile'; minSdk 26; targetSdk 36; versionCode 20; versionName '0.17.0'; testInstrumentationRunner 'androidx.test.runner.AndroidJUnitRunner' }
 compileOptions { coreLibraryDesugaringEnabled true; sourceCompatibility JavaVersion.VERSION_17; targetCompatibility JavaVersion.VERSION_17 }
 buildTypes { release { minifyEnabled false } }
}
dependencies {
 coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs:2.1.5'
 implementation platform('com.google.firebase:firebase-bom:35.0.0')
 implementation 'com.google.firebase:firebase-auth'
 implementation 'androidx.appcompat:appcompat:1.7.1'
 implementation 'androidx.activity:activity:1.10.1'
 implementation 'androidx.credentials:credentials:1.3.0'
 implementation 'androidx.credentials:credentials-play-services-auth:1.3.0'
 implementation 'com.google.android.libraries.identity.googleid:googleid:1.1.1'
 implementation 'com.google.android.material:material:1.13.0'
 implementation 'androidx.work:work-runtime:2.10.1'
 testImplementation 'junit:junit:4.13.2'
}
''')
(root/'gradle.properties').write_text('android.useAndroidX=true\norg.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8\norg.gradle.workers.max=2\n')
shutil.copy2(root/'Config/google-services.json',app/'google-services.json')
resources=root.parents[1]/'Resources'
for source,target in [('gendragoon_terms.txt','terms.txt'),('gendragoon_privacy.txt','privacy.txt')]:shutil.copy2(resources/source,main/'assets'/target)
(main/'AndroidManifest.xml').write_text('''<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools">
 <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES"/>
 <uses-permission android:name="android.permission.INTERNET"/><uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>
 <uses-permission android:name="android.permission.POST_NOTIFICATIONS"/><uses-permission android:name="android.permission.FOREGROUND_SERVICE"/><uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC"/>
 <application android:label="GenDragoon" android:theme="@style/Theme.GenDragoon" android:icon="@drawable/ic_cloud" android:allowBackup="false" android:usesCleartextTraffic="false" android:supportsRtl="true">
  <activity android:name=".MainActivity" android:exported="true" android:windowSoftInputMode="adjustResize"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity>
  <service android:name="androidx.work.impl.foreground.SystemForegroundService" android:foregroundServiceType="dataSync" tools:node="merge"/>
  <provider android:name="androidx.core.content.FileProvider" android:authorities="${applicationId}.files" android:exported="false" android:grantUriPermissions="true"><meta-data android:name="android.support.FILE_PROVIDER_PATHS" android:resource="@xml/file_paths"/></provider>
 </application>
</manifest>
''')
(main/'res/xml/file_paths.xml').write_text('<paths xmlns:android="http://schemas.android.com/apk/res/android"><files-path name="exports" path="exports/"/></paths>')
(main/'res/drawable/ic_cloud.xml').write_text('''<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24"><path android:fillColor="#C6A1FF" android:pathData="M19.35,10.04C18.67,6.59 15.64,4 12,4c-2.89,0 -5.4,1.64 -6.65,4.04C2.34,8.36 0,10.9 0,14c0,3.31 2.69,6 6,6h13c2.76,0 5,-2.24 5,-5 0,-2.64 -2.05,-4.78 -4.65,-4.96z"/></vector>''')
(main/'res/values/styles.xml').write_text('''<resources><style name="Theme.GenDragoon" parent="Theme.Material3.Dark.NoActionBar"><item name="colorPrimary">#C5A0FF</item><item name="colorOnPrimary">#231333</item><item name="colorSecondary">#C5A0FF</item><item name="colorSurface">#1D1829</item><item name="android:colorBackground">#10101A</item><item name="android:windowLightStatusBar">false</item><item name="android:windowLightNavigationBar">false</item><item name="android:statusBarColor">#10101A</item><item name="android:navigationBarColor">#10101A</item><item name="android:fontFamily">sans</item></style></resources>''')
(root/'.gitignore').write_text('.gradle/\nlocal.properties\n**/build/\n*.jks\n*.keystore\n')
print('ANDROID_PROJECT_CREATED',root)
