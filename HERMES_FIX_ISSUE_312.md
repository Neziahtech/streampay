# Solution for Issue #312

## Summary
The vulnerability is resolved by restricting access to initialize the policy module exclusively to the current `Governor` or initializing the policy module directly within `__constructor`. In `policy_init`, the stored `Governor` address is read from contract storage and `governor.require_auth()` is enforced, completely mitigating front-running attack vectors from unauthorized accounts following contract deployment.

## Implementation / Patch
```diff
--- a/contracts/streaming-payments/src/lib.rs
+++ b/contracts/streaming-payments/src/lib.rs
@@ -1640,7 +1640,11 @@ impl StreamingPayments {
     /// Initialize policy module with an admin
     pub fn policy_init(env: Env, admin: Address) {
-        policy::init(&env, &admin);
+        // Enforce authorization check against current stored Governor
+        let governor: Address = env.storage().instance().get(&stream::DataKey::Governor)
+            .expect("Governor not set");
+        governor.require_auth();
+
+        policy::init(&env, &admin);
     }
```

## Payout Address (Solana)
`3EZnNP2kfmY161XyqnRWEFgtYw6jWFXHnimU5RMqA8g8`
