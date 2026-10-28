package app.gendragoon.cloudssd.mobile;
import org.junit.Test;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import static org.junit.Assert.*;

public final class PortableVaultTest {
    private JSONObject fixture()throws Exception{try(InputStream input=getClass().getResourceAsStream("/portable-vault-v1.json")){assertNotNull("Generate reviewed public test resources first",input);ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] data=new byte[4096];int n;while((n=input.read(data))!=-1)out.write(data,0,n);return new JSONObject(out.toString("UTF-8"));}}
    @Test public void macCryptoKitVectorOpensInJceIncludingAstralPassphrase()throws Exception{JSONObject f=fixture();PortableVault.Keys result=PortableVault.open(f.getJSONObject("envelope").toString().getBytes(StandardCharsets.UTF_8),f.getString("password").toCharArray(),f.getString("receiverId"));assertEquals(f.getString("storageSecret"),result.secret);assertArrayEquals(PortableVault.decode(f.getString("keymap"),PortableVault.MAX_KEYMAP),result.keymap);}
    @Test public void tamperingWrongAccountWrongPasswordAndCostEscalationFailClosed()throws Exception{JSONObject f=fixture(),envelope=f.getJSONObject("envelope");byte[] bytes=envelope.toString().getBytes(StandardCharsets.UTF_8);String receiver=f.getString("receiverId");char[] password=f.getString("password").toCharArray();assertThrows(Exception.class,()->PortableVault.open(bytes,password,"f".repeat(64)));assertThrows(Exception.class,()->PortableVault.open(bytes,"wrong password 1234".toCharArray(),receiver));byte[] ciphertext=PortableVault.decode(envelope.getString("ciphertext"),PortableVault.MAX_PLAIN+16);ciphertext[0]^=1;envelope.put("ciphertext",PortableVault.encode(ciphertext));assertThrows(Exception.class,()->PortableVault.open(envelope.toString().getBytes(StandardCharsets.UTF_8),password,receiver));JSONObject invalid=new JSONObject(f.getJSONObject("envelope").toString());invalid.getJSONObject("kdf").put("iterations",600001);assertThrows(Exception.class,()->PortableVault.open(invalid.toString().getBytes(StandardCharsets.UTF_8),password,receiver));}
    @Test public void canonicalEncodingAndPortableKeymapShapeAreStrict()throws Exception{assertThrows(Exception.class,()->PortableVault.decode("AAAA=",100));assertThrows(Exception.class,()->PortableVault.decode("A+AA",100));byte[] keymap=PortableVault.decode(fixture().getString("keymap"),PortableVault.MAX_KEYMAP);byte[] hardware=Arrays.copyOf(keymap,96);hardware[4]=4;assertThrows(Exception.class,()->PortableVault.keymap(hardware));keymap[7]=0x7f;assertThrows(Exception.class,()->PortableVault.keymap(keymap));}
}
