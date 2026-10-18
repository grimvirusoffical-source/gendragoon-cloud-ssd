"use strict";
// Real object store for workspace purge and merge, backed by the customer GCS bucket.
// Tests inject an in-memory store with the same shape instead.
function assertWorkspacePrefix(prefix){
 if(typeof prefix!=="string"||!/^customer\/[a-f0-9]{64}\/managed\/[A-Za-z0-9-]+\/$/.test(prefix))
  throw Object.assign(new Error("refusing to delete outside one workspace prefix"),{code:"object_store_prefix_rejected"});
}
function gcsObjectStore(bucket){
 if(!bucket||typeof bucket.file!=="function")throw new Error("gcsObjectStore needs a @google-cloud/storage Bucket");
 async function stat(key){
  const [meta]=await bucket.file(key).getMetadata();
  return {size:meta.size==null?null:Number(meta.size),crc32c:meta.crc32c,md5Hash:meta.md5Hash,etag:meta.etag};
 }
 return {
  // force:true keeps going past single failures and then rejects, so the purge step stays in error.
  async deletePrefix(prefix){assertWorkspacePrefix(prefix);await bucket.deleteFiles({prefix,force:true});},
  // Not found is already deleted (a retry after a partial purge).
  async delete(key){await bucket.file(key).delete({ignoreNotFound:true});},
  async copy(from,to){await bucket.file(from).copy(bucket.file(to));return stat(to);},
  stat,
  async read(key){const [bytes]=await bucket.file(key).download();return bytes;}
 };
}
module.exports={gcsObjectStore,assertWorkspacePrefix};
