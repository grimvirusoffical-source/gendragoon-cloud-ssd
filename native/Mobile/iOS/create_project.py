from pathlib import Path
import hashlib,json,plistlib,shutil
root=Path(__file__).resolve().parent
name='GenDragoonMobile';bundle='app.gendragoon.cloudssd.mobile'
config=plistlib.loads((root/'Config/GoogleService-Info.plist').read_bytes())
assert config['BUNDLE_ID']==bundle
for p in (root/'Sources').glob('*.swift'):
 s=p.read_text().replace(')==.orderedAscending',') == .orderedAscending');p.write_text(s)
info={'CFBundleDisplayName':'GenDragoon','CFBundleName':'GenDragoon','CFBundleIdentifier':'$(PRODUCT_BUNDLE_IDENTIFIER)','CFBundleExecutable':'$(EXECUTABLE_NAME)','CFBundlePackageType':'APPL','CFBundleShortVersionString':'1.0','CFBundleVersion':'20','CFBundleURLTypes':[{'CFBundleURLSchemes':[config['REVERSED_CLIENT_ID']]}],'UILaunchScreen':{},'UIApplicationSceneManifest':{'UIApplicationSupportsMultipleScenes':False},'UISupportedInterfaceOrientations':['UIInterfaceOrientationPortrait','UIInterfaceOrientationLandscapeLeft','UIInterfaceOrientationLandscapeRight'],'UISupportedInterfaceOrientations~ipad':['UIInterfaceOrientationPortrait','UIInterfaceOrientationPortraitUpsideDown','UIInterfaceOrientationLandscapeLeft','UIInterfaceOrientationLandscapeRight'],'UIFileSharingEnabled':True,'LSSupportsOpeningDocumentsInPlace':True,'ITSAppUsesNonExemptEncryption':False}
(root/'Info.plist').write_bytes(plistlib.dumps(info))
objects={}
def uid(label):return hashlib.sha1(label.encode()).hexdigest()[:24].upper()
def obj(label,isa,**fields):i=uid(label);objects[i]={'isa':isa,**fields};return i
sources=sorted(p.relative_to(root).as_posix() for p in (root/'Sources').glob('*.swift'))
resources=sorted(p.relative_to(root).as_posix() for p in (root/'Resources').iterdir() if p.is_file())+['Config/GoogleService-Info.plist','Resources/Assets.xcassets']
sref=[];sb=[];rref=[];rb=[]
for p in sources:
 f=obj(p,'PBXFileReference',lastKnownFileType='sourcecode.swift',path=p,sourceTree='<group>');sref.append(f);sb.append(obj('build '+p,'PBXBuildFile',fileRef=f))
for p in resources:
 f=obj(p,'PBXFileReference',lastKnownFileType='folder.assetcatalog' if p.endswith('.xcassets') else 'text.plist.xml' if p.endswith('.plist') else 'text',path=p,sourceTree='<group>');rref.append(f);rb.append(obj('build '+p,'PBXBuildFile',fileRef=f))
plist=obj('plist','PBXFileReference',lastKnownFileType='text.plist.xml',path='Info.plist',sourceTree='<group>')
product=obj('product','PBXFileReference',explicitFileType='wrapper.application',includeInIndex='0',path=name+'.app',sourceTree='BUILT_PRODUCTS_DIR')
package=obj('google-package','XCRemoteSwiftPackageReference',repositoryURL='https://github.com/google/GoogleSignIn-iOS.git',requirement={'kind':'exactVersion','version':'10.0.0'})
zip_package=obj('zip-package','XCRemoteSwiftPackageReference',repositoryURL='https://github.com/weichsel/ZIPFoundation.git',requirement={'kind':'exactVersion','version':'0.9.20'})
pdeps=[obj('pkg-'+x,'XCSwiftPackageProductDependency',package=package,productName=x) for x in ['GoogleSignIn','GoogleSignInSwift']]
pbuild=[obj('pkgb-'+x,'PBXBuildFile',productRef=uid('pkg-'+x)) for x in ['GoogleSignIn','GoogleSignInSwift']]
pdeps.append(obj('pkg-ZIPFoundation','XCSwiftPackageProductDependency',package=zip_package,productName='ZIPFoundation'))
pbuild.append(obj('pkgb-ZIPFoundation','PBXBuildFile',productRef=uid('pkg-ZIPFoundation')))
sourcephase=obj('sources-phase','PBXSourcesBuildPhase',buildActionMask='2147483647',files=sb,runOnlyForDeploymentPostprocessing='0')
resourcephase=obj('resources-phase','PBXResourcesBuildPhase',buildActionMask='2147483647',files=rb,runOnlyForDeploymentPostprocessing='0')
frameworkphase=obj('framework-phase','PBXFrameworksBuildPhase',buildActionMask='2147483647',files=pbuild,runOnlyForDeploymentPostprocessing='0')
pg=obj('products','PBXGroup',children=[product],name='Products',sourceTree='<group>')
group=obj('main-group','PBXGroup',children=sref+rref+[plist,pg],sourceTree='<group>')
project_configs=[];target_configs=[]
for mode in ['Debug','Release']:
 settings={'CLANG_ENABLE_MODULES':'YES','CLANG_ENABLE_OBJC_ARC':'YES','IPHONEOS_DEPLOYMENT_TARGET':'17.0','SDKROOT':'iphoneos','SWIFT_VERSION':'5.0','SWIFT_OPTIMIZATION_LEVEL':'-Onone' if mode=='Debug' else '-O','DEBUG_INFORMATION_FORMAT':'dwarf' if mode=='Debug' else 'dwarf-with-dsym'}
 project_configs.append(obj('proj-'+mode,'XCBuildConfiguration',name=mode,buildSettings=settings))
 settings={'ASSETCATALOG_COMPILER_APPICON_NAME':'AppIcon','PRODUCT_BUNDLE_IDENTIFIER':bundle,'PRODUCT_NAME':name,'INFOPLIST_FILE':'Info.plist','GENERATE_INFOPLIST_FILE':'NO','CODE_SIGN_STYLE':'Automatic','DEVELOPMENT_TEAM':'NZPU8H843J','TARGETED_DEVICE_FAMILY':'1,2','SUPPORTED_PLATFORMS':'iphoneos iphonesimulator','SUPPORTS_MACCATALYST':'NO','LD_RUNPATH_SEARCH_PATHS':['$(inherited)','@executable_path/Frameworks'],'OTHER_LDFLAGS':['$(inherited)','-ObjC'],'SWIFT_EMIT_LOC_STRINGS':'YES','SWIFT_VERSION':'5.0'}
 if mode=='Debug':settings['SWIFT_ACTIVE_COMPILATION_CONDITIONS']='DEBUG'
 target_configs.append(obj('target-'+mode,'XCBuildConfiguration',name=mode,buildSettings=settings))
tcl=obj('target-config-list','XCConfigurationList',buildConfigurations=target_configs,defaultConfigurationIsVisible='0',defaultConfigurationName='Release')
pcl=obj('project-config-list','XCConfigurationList',buildConfigurations=project_configs,defaultConfigurationIsVisible='0',defaultConfigurationName='Release')
target=obj('target','PBXNativeTarget',name=name,productName=name,productType='com.apple.product-type.application',productReference=product,buildConfigurationList=tcl,buildPhases=[sourcephase,frameworkphase,resourcephase],buildRules=[],dependencies=[],packageProductDependencies=pdeps)
project=obj('project','PBXProject',attributes={'BuildIndependentTargetsInParallel':'YES','LastUpgradeCheck':'2700','TargetAttributes':{target:{'CreatedOnToolsVersion':'27.0','DevelopmentTeam':'NZPU8H843J'}}},buildConfigurationList=pcl,compatibilityVersion='Xcode 14.0',developmentRegion='en',hasScannedForEncodings='0',knownRegions=['en','Base'],mainGroup=group,productRefGroup=pg,projectDirPath='',projectRoot='',targets=[target],packageReferences=[package,zip_package])
def serialize(v):
 if isinstance(v,dict):return '{ '+ ' '.join(json.dumps(k)+ ' = '+serialize(x)+';' for k,x in v.items())+' }'
 if isinstance(v,list):return '('+', '.join(serialize(x) for x in v)+')'
 return json.dumps(str(v))
p=root/(name+'.xcodeproj');p.mkdir(exist_ok=True)
(p/'project.pbxproj').write_text('// !$*UTF8*$!\n'+serialize({'archiveVersion':'1','classes':{},'objectVersion':'56','objects':objects,'rootObject':project})+'\n')
schemes=p/'xcshareddata/xcschemes';schemes.mkdir(parents=True,exist_ok=True)
ref=f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target}" BuildableName="{name}.app" BlueprintName="{name}" ReferencedContainer="container:{name}.xcodeproj"/>'
(schemes/(name+'.xcscheme')).write_text(f'''<?xml version="1.0" encoding="UTF-8"?><Scheme LastUpgradeVersion="2700" version="1.3"><BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{ref}</BuildActionEntry></BuildActionEntries></BuildAction><LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{ref}</BuildableProductRunnable></LaunchAction><ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">{ref}</BuildableProductRunnable></ProfileAction><AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/></Scheme>''')
print('XCODE_PROJECT_CREATED',p,'SOURCE_FILES',len(sources),'PACKAGE','GoogleSignIn 10.0.0')
