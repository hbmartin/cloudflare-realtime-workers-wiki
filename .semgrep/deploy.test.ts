declare const savedDB: any;
declare const deployedDB: any;
declare const binding: any;
declare const declaredDB: any;
declare const databaseName: string;
declare const api: any;
declare const account: any;
declare function consume(value: any): void;

// ruleid: deploy-d1-deprecated-id
consume(savedDB.id);
// ruleid: deploy-d1-deprecated-id
consume(deployedDB?.id);
// ruleid: deploy-d1-deprecated-id
consume(binding.id);
// ok: deploy-d1-deprecated-id
consume(savedDB.database_id);
// ok: deploy-d1-deprecated-id
consume(account.id);

function deployedDatabaseID(savedBinding: any) {
  // ok: deploy-d1-deprecated-id
  return savedBinding.database_id ?? savedBinding.id;
}
consume(deployedDatabaseID(binding));

// ruleid: deploy-d1-template-name
api(`/d1/database?name=${encodeURIComponent(declaredDB.database_name)}`);
// ruleid: deploy-d1-template-name
api("/d1/database", { method: "POST", body: { name: declaredDB.database_name } });
// ruleid: deploy-d1-template-name
api("/d1/database?name=noteflare");
// ok: deploy-d1-template-name
api(`/d1/database?name=${encodeURIComponent(databaseName)}`);
// ok: deploy-d1-template-name
api("/d1/database", { method: "POST", body: { name: databaseName } });
