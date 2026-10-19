# Solution for Issue #312

## Summary
### 1. Короткий опис виправлення

Вразливість усувається шляхом обмеження доступу до ініціалізації модуля політик виключно для поточного `Governor` або повної ініціалізації модуля безпосередньо всередині `__constructor`. У методі `policy_init` зчитується збережена адреса `Governor` зі сховища контракту та викликається `governor.require_auth()`, що унеможливлює front-running атаку сторонніми акаунтами після деплою контракту.

---

### 2. Конкретний фікс (Code Patch)

#### Варіант A: Авторизація ч

## Implementation / Patch
```
### 1. Короткий опис виправлення

Вразливість усувається шляхом обмеження доступу до ініціалізації модуля політик виключно для поточного `Governor` або повної ініціалізації модуля безпосередньо всередині `__constructor`. У методі `policy_init` зчитується збережена адреса `Governor` зі сховища контракту та викликається `governor.require_auth()`, що унеможливлює front-running атаку сторонніми акаунтами після деплою контракту.

---

### 2. Конкретний фікс (Code Patch)

#### Варіант A: Авторизація через збереженого `Governor` у `policy_init`

```diff
--- a/contracts/streaming-payments/src/lib.rs
+++ b/contracts/streaming-payments/src/lib.rs
@@ -1640,7 +1640,11 @@ impl StreamingPayments {
     /// Initialize policy module with an admin
     pub fn policy_init(env: Env, admin: Address) {
-        policy::init(&env, &admin);
+        // Завантажуємо поточного Governor та перевіряємо його підпис
+        let governor: Address = env.storage().instance().get(&stream::DataKey::Governor)
+            .expect("Governor not set");
+        governor.require_auth();
+
+        policy::init(&env, &admin);
     }
```

#### Варіант B: Автоматична ініціалізація в `__constructor` (рекомендований для усунення вікна ініціалізації)

```diff
--- a/contracts/streaming-payments/src/lib.rs
+++ b/contracts/streaming-payments/src/lib.rs
@@ -...,... +...,... @@
     pub fn __constructor(env: Env, governor: Address) {
         governor.require_auth();
         env.storage().instance().set(&stream::DataKey::Governor, &governor);
+        
+        // Автоматично ініціалізуємо модуль політик з Governor як дефолтним адміном
+        policy::init(&env, &governor);
     }
```

> **Примітка:** Якщо використовується Варіант B, окремий публічний виклик `policy_init` слід видалити або захистити перевіркою `policy::has_admin(&env)` з обмеженням прав через `Governor`.
```

## Payout Address (Solana)
`3EZnNP2kfmY161XyqnRWEFgtYw6jWFXHnimU5RMqA8g8`
