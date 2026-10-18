package app.gendragoon.cloudssd.mobile;

import java.util.ArrayList;
import java.util.List;

/**
 * Local data removed after an account is deleted. Workspace lock does not use this plan:
 * upload checkpoints and partial files stay so a transfer can resume.
 * Bring-your-own credentials are not stored yet. The preference name and keystore prefix
 * are cleared anyway so a later credential store cannot survive account deletion.
 */
final class LocalDataWipe {
    static final List<String> PREFERENCES=List.of("gd-settings","gd-transfer-checkpoints","gd-byo-credentials");
    static final List<String> CACHE_DIRS=List.of("gd-inputs","gd-downloads","gd-folder-inputs");
    static final String FILES_DIR="exports";
    static final String KEYSTORE_PREFIX="gd-byo-";
    static final String ACTIVITY_KEY_DATA_SAVER="data-saver";

    private LocalDataWipe(){}

    static boolean accountWipeClears(String name){
        if(name==null)return false;
        return PREFERENCES.contains(name)||CACHE_DIRS.contains(name)||FILES_DIR.equals(name)||ACTIVITY_KEY_DATA_SAVER.equals(name)||name.startsWith(KEYSTORE_PREFIX);
    }

    static boolean lockPauseClears(String name){return false;}

    static List<String> lockPauseDeletes(){return List.of();}

    static List<String> keystoreAliasesToDelete(Iterable<String> aliases){
        List<String> matched=new ArrayList<>();
        if(aliases==null)return matched;
        for(String alias:aliases)if(alias!=null&&alias.startsWith(KEYSTORE_PREFIX))matched.add(alias);
        return matched;
    }

    /** Keystore aliases removed for this deletion outcome. A 401 passes {@code wipe=false} and removes none. */
    static List<String> secretsRemoved(boolean wipe,Iterable<String> aliases){
        if(!wipe)return List.of();
        return keystoreAliasesToDelete(aliases);
    }
}
