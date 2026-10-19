# Solution for Issue #292

## Summary
### 1. Опис виправлення

У точках входу релаєра для виведення та клірингу (settlement routines) впроваджено сувору перевірку стану circuit-breaker (`ensure_not_paused`), яка гарантує негайний `revert` у разі паузи системи або деактивації спонсора перед виконанням трансферів. Крім того, виправлено логіку диспетчеризації розрахунків шляхом обов'язкової публікації подій телеметрії (`SettlementTelemetryEvent`) навіть за умов паралельної ротації ключів оператора (`rotate_operator_key`) чи зміни стану

## Implementation / Patch
```
### 1. Опис виправлення

У точках входу релаєра для виведення та клірингу (settlement routines) впроваджено сувору перевірку стану circuit-breaker (`ensure_not_paused`), яка гарантує негайний `revert` у разі паузи системи або деактивації спонсора перед виконанням трансферів. Крім того, виправлено логіку диспетчеризації розрахунків шляхом обов'язкової публікації подій телеметрії (`SettlementTelemetryEvent`) навіть за умов паралельної ротації ключів оператора (`rotate_operator_key`) чи зміни стану спонсора (`set_sponsor_active`).

---

### 2. Код патчу

```diff
--- a/contracts/streaming-payments/src/lib.rs
+++ b/contracts/streaming-payments/src/lib.rs
@@ -1505,18 +1505,25 @@ impl StreamingPaymentsContract {
     pub fn relayer_withdraw_settlement(
         env: Env,
         relayer: Address,
         sponsor: Address,
         stream_id: u64,
         amount: i128,
     ) -> Result<(), Error> {
         relayer.require_auth();
 
+        // [SECURITY FIX]: Enforce circuit-breaker pause guards before any dispatch
+        Self::ensure_not_paused(&env)?;
+        Self::ensure_sponsor_active(&env, &sponsor)?;
+
         let mut stream = Self::get_stream(&env, stream_id)?;
         Self::validate_operator_key(&env, &relayer, &sponsor)?;
 
-        // Settlement execution was previously unguarded against circuit-breaker pause
         let transferred = Self::internal_settle_stream(&env, &mut stream, amount)?;
 
+        // [TELEMETRY FIX]: Emit settlement telemetry before persisting final state
+        env.events().publish(
+            (symbol_short!("settle"), sponsor, relayer),
+            SettlementTelemetry {
+                stream_id,
+                amount: transferred,
+                timestamp: env.ledger().timestamp(),
+            },
+        );
+
         Self::set_stream(&env, stream_id, &stream);
         Ok(())
     }
@@ -1535,6 +1542,13 @@ impl StreamingPaymentsContract {
     pub fn rotate_operator_key(
         env: Env,
         sponsor: Address,
         new_operator: Address,
     ) -> Result<(), Error> {
         sponsor.require_auth();
+        Self::ensure_not_paused(&env)?;
+
         Self::set_operator_key(&env, &sponsor, &new_operator);
+        
+        env.events().publish(
+            (symbol_short!("op_rotate"), sponsor),
+            new_operator,
+        );
         Ok(())
     }
```
```

## Payout Address (Solana)
`3EZnNP2kfmY161XyqnRWEFgtYw6jWFXHnimU5RMqA8g8`
