# GenDragoonSSD — API access & SDKs

**Preview: free private workspace only.** The cloud provider's own credentials, bucket name, account-wide keys and administrator rights are NEVER shared with customer integrations. Paid workspace SDKs, app streaming across arbitrary platforms, and real-money subscriptions are not available.

## Start safely

1. Sign into **GenDragoon Cloud SSD** with Google, accept Terms, create your **2 GB Free Workspace**.
2. In **Account → Developer API access**, create a key with **files:read** or **files:read + files:write**.
3. Copy the key **once** into a trusted server-side secrets manager. Keys start with gdsk_, are SHA-256 hashed server-side, expire after 90 days, and are revocable from the app. Max five active keys per free account.
4. Set the environment variable GENDRAGOON_API_KEY in the **backend process**. Never embed it into public browser JS, mobile apps, apps distributed to users, git, console logs, or screenshots.
5. Call the HTTPS API; requests are restricted to the creator's free workspace and 2,000,000,000-byte quota.

**Endpoint:** https://gendragoon-free-10068843866.us-central1.run.app

**API description:** [OpenAPI 3](./openapi.yaml) for generating typed clients.

## Ready-to-run SDKs

- [Python 3 standard-library client](./python/gendragoon.py) — status, list, chunked upload, download, delete.
- [Node.js client](./javascript/gendragoon.mjs) — status, list, chunked upload, streamed download, delete.

Both download methods keep the existing **no-overwrite** contract. They stream
into a private sibling staging directory, validate `Content-Length` when
provided, and publish a complete file atomically. An existing destination,
including a symlink or a file created during the transfer, causes failure and
is preserved. Network, disk, HTTP and integrity failures remove only that
request's staging files. Concurrent downloads to one destination produce one
complete winner; the other request fails without replacing it.
API file identifiers are UUIDs; Python validates download/delete IDs before
requesting them, and Node encodes IDs as a single URL path component.

Publication requires same-filesystem hard-link support. FAT/exFAT and other
filesystems without that support fail safely; choose a supported local volume.
No partial-file copy fallback is used. Downloads request identity encoding and
reject encoded responses so the byte-count check applies to the stored file.
Without a server length or trusted checksum, a client cannot prove that a
cleanly terminated response contains all the intended remote bytes.

All Python and Node requests reject redirects, including same-origin redirects.
API credentials are never replayed to a redirect destination or a downgraded
HTTP URL. Use the documented HTTPS endpoint that serves file bytes directly;
redirected/signed external download URLs need a separate explicit integration.
TLS certificate verification remains enabled. The Node transport has a
240-second request/body abort deadline; Python uses a 240-second socket timeout.

Run the local SDK regression suites from the repository root:

~~~bash
python3 -B -m unittest discover -s sdk/python/tests -v
node --test sdk/javascript/tests/gendragoon.test.mjs
~~~

The tests require OpenSSL to generate disposable local TLS identities. They
exercise trusted HTTPS, rejection of an untrusted certificate, blocked
cross-origin and HTTP downgrade redirects, truncated streams, asynchronous disk
errors, private staging cleanup and concurrent destination preservation. They
use fixture credentials and local servers; passing them does not establish
live backend availability, account isolation, billing or full app readiness.

### Universal HTTPS example

~~~bash
export GENDRAGOON_API_KEY="paste_your_own_secret_from_the_mac_app"
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $GENDRAGOON_API_KEY" \
  "https://gendragoon-free-10068843866.us-central1.run.app/v1/files"
~~~

## Every major programming language

Every example below **uses the same live API**. These are small reference integrations that list files, not yet complete QA-certified packages for each language. Use the OpenAPI definition to generate full typed clients.

### Python

~~~python
import os
from sdk.python.gendragoon import GenDragoon
cloud = GenDragoon(os.environ["GENDRAGOON_API_KEY"])
print(cloud.list_files())
# cloud.upload("beat.wav")
~~~

### JavaScript / TypeScript (Node.js server)

~~~javascript
import {GenDragoon} from "./javascript/gendragoon.mjs";
const cloud = new GenDragoon(process.env.GENDRAGOON_API_KEY);
console.log(await cloud.listFiles());
~~~

### Java 11+

~~~java
import java.net.URI;
import java.net.http.*;
public class Demo {
  public static void main(String[] args) throws Exception {
    String base="https://gendragoon-free-10068843866.us-central1.run.app";
    var request=HttpRequest.newBuilder(URI.create(base+"/v1/files"))
      .header("Authorization","Bearer "+System.getenv("GENDRAGOON_API_KEY"))
      .GET().build();
    var response=HttpClient.newHttpClient().send(request,HttpResponse.BodyHandlers.ofString());
    System.out.println("Status: "+response.statusCode()+" Body: "+response.body());
  }
}
~~~

### C# / .NET 6+

~~~csharp
using System;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Threading.Tasks;
using var http = new HttpClient();
http.DefaultRequestHeaders.Authorization =
  new AuthenticationHeaderValue("Bearer", Environment.GetEnvironmentVariable("GENDRAGOON_API_KEY"));
Console.WriteLine(await http.GetStringAsync(
 "https://gendragoon-free-10068843866.us-central1.run.app/v1/files"));
~~~

### C with libcurl

~~~c
#include <curl/curl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(void) {
 const char *key=getenv("GENDRAGOON_API_KEY");
 if (!key) return 2;
 char header[512];
 if (snprintf(header,sizeof(header),"Authorization: Bearer %s",key)>=(int)sizeof(header))return 3;
 CURL *c=curl_easy_init(); if(!c)return 1;
 struct curl_slist *headers=NULL;
 headers=curl_slist_append(headers,header);
 curl_easy_setopt(c,CURLOPT_URL,"https://gendragoon-free-10068843866.us-central1.run.app/v1/files");
 curl_easy_setopt(c,CURLOPT_HTTPHEADER,headers);
 CURLcode result=curl_easy_perform(c);
 curl_slist_free_all(headers); curl_easy_cleanup(c);
 return result==CURLE_OK?0:1;
}
~~~

### C++ with libcurl

~~~cpp
#include <curl/curl.h>
#include <cstdlib>
#include <string>
int main() {
 const char* key=std::getenv("GENDRAGOON_API_KEY");if(!key)return 2;
 CURL* c=curl_easy_init();if(!c)return 1;
 std::string auth=std::string("Authorization: Bearer ")+key;
 struct curl_slist* h=curl_slist_append(nullptr,auth.c_str());
 curl_easy_setopt(c,CURLOPT_URL,"https://gendragoon-free-10068843866.us-central1.run.app/v1/files");
 curl_easy_setopt(c,CURLOPT_HTTPHEADER,h);
 auto result=curl_easy_perform(c);
 curl_slist_free_all(h);curl_easy_cleanup(c);
 return result==CURLE_OK?0:1;
}
~~~

### Go 1.21+

~~~go
package main
import ("fmt";"net/http";"os";"io")
func main(){
 req,_:=http.NewRequest("GET","https://gendragoon-free-10068843866.us-central1.run.app/v1/files",nil)
 req.Header.Set("Authorization","Bearer "+os.Getenv("GENDRAGOON_API_KEY"))
 res,err:=http.DefaultClient.Do(req);if err!=nil{panic(err)}
 defer res.Body.Close()
 out,_:=io.ReadAll(io.LimitReader(res.Body,1024*1024))
 fmt.Println(res.StatusCode,string(out))
}
~~~

### PHP 8+

~~~php
<?php
$curl=curl_init("https://gendragoon-free-10068843866.us-central1.run.app/v1/files");
curl_setopt($curl,CURLOPT_HTTPHEADER,["Authorization: Bearer ".getenv("GENDRAGOON_API_KEY")]);
curl_setopt($curl,CURLOPT_RETURNTRANSFER,true);
echo curl_exec($curl);
curl_close($curl);
~~~

### Ruby

~~~ruby
require "net/http"
uri=URI("https://gendragoon-free-10068843866.us-central1.run.app/v1/files")
req=Net::HTTP::Get.new(uri)
req["Authorization"]="Bearer #{ENV.fetch("GENDRAGOON_API_KEY")}"
puts Net::HTTP.start(uri.host,uri.port,use_ssl:true){|http|http.request(req).body}
~~~

### Rust with reqwest + tokio

~~~rust
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
 let key=std::env::var("GENDRAGOON_API_KEY")?;
 let response=reqwest::Client::new()
  .get("https://gendragoon-free-10068843866.us-central1.run.app/v1/files")
  .bearer_auth(key).send().await?.error_for_status()?.text().await?;
 println!("{}",response);Ok(())
}
~~~

### Swift

~~~swift
import Foundation
let token=ProcessInfo.processInfo.environment["GENDRAGOON_API_KEY"] ?? ""
var req=URLRequest(url:URL(string:"https://gendragoon-free-10068843866.us-central1.run.app/v1/files")!)
req.setValue("Bearer "+token,forHTTPHeaderField:"Authorization")
let semaphore=DispatchSemaphore(value:0)
URLSession.shared.dataTask(with:req){data,response,error in
  print(String(data:data ?? Data(),encoding:.utf8) ?? "")
  semaphore.signal()
}.resume()
semaphore.wait()
~~~

## Upload, download, sync and limits

The API works across languages through standard HTTP:

- List: GET /v1/files (files:read).
- Reserve quota: POST /v1/uploads with JSON name and sizeBytes (files:write).
- Upload: PUT /v1/uploads/{uploadId}/chunks/{index} with sequential **binary** chunks of exactly the returned chunkBytes size (final chunk may be shorter).
- Check progress after a network interruption: GET /v1/uploads/{uploadId}; resume using nextIndex.
- Verify file stored: POST /v1/uploads/{uploadId}/finalize.
- Restore: GET /v1/files/{fileId}/download, streaming to a local file.
- Delete: DELETE /v1/files/{fileId} (files:write).
- Key management: GET/POST /v1/keys and DELETE /v1/keys/{keyId}, using the short-lived **Google Firebase ID token**, never a minted gdsk_ key.

This preview is a file-sync API, **not a mount protocol**, not POSIX storage, not arbitrary app execution, and not a substitute for a backup or production disaster-recovery service. A robust multi-device sync engine must additionally implement checkpoints, conflicting filenames, checksums, offline queues and conflict resolution; these are not yet shipped.

## Generate clients from OpenAPI

OpenAPI Generator supports Python, Java, JavaScript, C#, C++, Go, PHP, Swift, Rust and more. For example (requires the OpenAPI Generator CLI and its supported Java runtime):

~~~bash
openapi-generator-cli generate -i sdk/openapi.yaml -g java -o generated/java
openapi-generator-cli generate -i sdk/openapi.yaml -g csharp -o generated/csharp
openapi-generator-cli generate -i sdk/openapi.yaml -g cpp-restsdk -o generated/cpp
~~~

**Preview security:** Key revocation, TLS, account isolation and backend quotas are enforced server-side; SDK code must not trust unverified web inputs. The SaaS still requires end-to-end customer tests and a production readiness/security review before paid launch.
