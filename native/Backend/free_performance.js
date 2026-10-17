"use strict";
const {TransferGovernor:VerifiedGovernor}=require("./performance");
// The original free project can now be upgraded in place. Its worker allowance
// comes from verified entitlements exactly like a newer product project.
class TransferGovernor extends VerifiedGovernor {
 constructor(){super(20)}
 async run(id,workspace,operation){
  if(workspace.kind!=="free"||workspace.provisioned!==true)throw Error("Not provisioned");
  return super.run(id,workspace,operation);
 }
}
module.exports={TransferGovernor};
