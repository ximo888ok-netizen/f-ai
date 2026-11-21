const options = {
  task: 'taskNotifications',
  member: 'memberNotifications',
  rights: 'rightsNotifications',
};

export async function notify(db, workspaceId, accountId, category, type, key, data) {
  await db.query(`
    INSERT INTO notifications(workspace_id,account_id,type,event_key,data)
    SELECT $1,$2,$3,$4,$5
    WHERE NOT EXISTS (SELECT 1 FROM account_settings
      WHERE workspace_id=$1 AND account_id=$2 AND preferences->$6::text='false'::jsonb)
    ON CONFLICT DO NOTHING`,
    [workspaceId,accountId,type,key,data,options[category]]);
}
