// Biometric / OS-keychain wrap-key plugin (Agent 1).
//
// Threat model - see `mvp-development.md` and the Agent 1 brief.
// We never store the master encryption key at rest. Instead, on the
// first successful passphrase+SecretKey unlock the JS layer:
//
//   1. derives `masterRaw` (the actual AES key for note bodies)
//   2. generates a fresh 32-byte `wrap_key`
//   3. AES-GCMs `masterRaw` with `wrap_key` and stores the resulting
//      ciphertext blob + nonce in IndexedDB (`meta.master_wrap_blob`)
//   4. asks THIS plugin to stash `wrap_key` in the OS keychain, gated
//      behind the platform's user-presence check (Touch ID / Watch /
//      Windows Hello / libsecret unlock)
//
// On a cold start with a still-valid JWT, `biometric_load` triggers
// the OS biometric prompt. If the user passes, we hand the wrap_key
// back to JS, which decrypts the blob and rebuilds the in-memory
// session. Anyone with physical access + valid biometric can unlock
// - same threat model as 1Password / Bitwarden quick-unlock. The
// encrypted notes remain safe against passive attackers and stolen
// disk images.
//
// Per-platform implementations are gated with `#[cfg(target_os = ..)]`.

/// Service name composed from the bundle id + a per-feature suffix.
/// macOS uses this as the keychain service; Windows uses it as the
/// PasswordVault resource name. Bundle id matches `tauri.conf.json`.
fn service_for(key_id: &str) -> String {
    format!("md.meo.desktop.{}", key_id)
}

// ─── Tauri command surface ───────────────────────────────────────────
//
// All commands take/return strings (base64 for the key payload). Errors
// surface to the JS side as the Promise rejection's message.

#[tauri::command]
pub async fn biometric_save(key_id: String, key_b64: String) -> Result<(), String> {
    platform::save(&key_id, &key_b64)
}

#[tauri::command]
pub async fn biometric_load(key_id: String) -> Result<String, String> {
    platform::load(&key_id)
}

#[tauri::command]
pub async fn biometric_clear(key_id: String) -> Result<(), String> {
    platform::clear(&key_id)
}

#[tauri::command]
pub async fn biometric_available() -> Result<bool, String> {
    Ok(platform::available())
}

// ─── macOS implementation ────────────────────────────────────────────
//
// We use Security.framework directly because `security-framework`'s
// high-level ItemAddOptions doesn't expose `kSecAttrAccessControl`,
// and that's the whole point - without the userPresence ACL the
// keychain entry would be readable without the biometric prompt.

#[cfg(target_os = "macos")]
mod platform {
    use super::service_for;
    use core_foundation::base::{CFTypeRef, TCFType, ToVoid};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::data::CFData;
    use core_foundation::dictionary::CFMutableDictionary;
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;
    use security_framework::access_control::{ProtectionMode, SecAccessControl};
    use security_framework_sys::access_control::kSecAccessControlUserPresence;
    use security_framework_sys::base::errSecItemNotFound;
    use security_framework_sys::item::{
        kSecAttrAccessControl, kSecAttrAccount, kSecAttrService, kSecAttrSynchronizable,
        kSecClass, kSecClassGenericPassword, kSecMatchLimit, kSecReturnData,
        kSecUseDataProtectionKeychain, kSecValueData,
    };
    use security_framework_sys::keychain_item::{SecItemAdd, SecItemCopyMatching, SecItemDelete};
    use std::ffi::c_void;
    use std::ptr;

    const ACCOUNT: &str = "default";

    pub fn available() -> bool {
        // We can't reliably probe "is Touch ID enrolled?" without
        // pulling in LocalAuthentication.framework. Even when biometric
        // hardware is missing the keychain falls back to the login
        // password sheet, which still satisfies the user-presence
        // requirement we care about. So: yes, attempt-able on macOS.
        true
    }

    /// Helper: add a (constant key, value) pair to the dictionary. The
    /// keychain APIs expect raw `*const c_void` cells under the hood;
    /// the standard idiom in `security-framework` is `&key.to_void()`
    /// + `&value.to_void()` against a default-typed CFMutableDictionary.
    #[inline]
    fn add_pair(
        dict: &mut CFMutableDictionary,
        key: *const c_void,
        value: *const c_void,
    ) {
        dict.add(&key, &value);
    }

    fn build_query_dict(service: &str) -> CFMutableDictionary {
        let mut dict = CFMutableDictionary::new();
        unsafe {
            add_pair(&mut dict, kSecClass.to_void(), kSecClassGenericPassword.to_void());
            add_pair(
                &mut dict,
                kSecAttrService.to_void(),
                CFString::new(service).as_CFTypeRef() as *const c_void,
            );
            add_pair(
                &mut dict,
                kSecAttrAccount.to_void(),
                CFString::new(ACCOUNT).as_CFTypeRef() as *const c_void,
            );
            add_pair(
                &mut dict,
                kSecUseDataProtectionKeychain.to_void(),
                CFBoolean::true_value().to_void(),
            );
        }
        dict
    }

    pub fn save(key_id: &str, key_b64: &str) -> Result<(), String> {
        let service = service_for(key_id);

        // Build a SecAccessControl requiring user presence. The
        // userPresence flag combines Touch ID, Watch unlock and a
        // login-password fallback - the OS picks the best available.
        let access = SecAccessControl::create_with_protection(
            Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
            kSecAccessControlUserPresence,
        )
        .map_err(|e| format!("create access control: {e}"))?;

        // Best-effort: clear any stale entry first. SecItemAdd would
        // fail with `errSecDuplicateItem` otherwise. We don't
        // propagate clear errors - the caller's intent is "set this
        // to the new value", a stale unreadable entry shouldn't block.
        let _ = clear(key_id);

        // Hold the temporaries in named bindings so the CFString /
        // CFData / SecAccessControl don't drop before SecItemAdd.
        let svc_str = CFString::new(&service);
        let acct_str = CFString::new(ACCOUNT);
        let data = CFData::from_buffer(key_b64.as_bytes());

        let mut dict = CFMutableDictionary::new();
        unsafe {
            add_pair(&mut dict, kSecClass.to_void(), kSecClassGenericPassword.to_void());
            add_pair(
                &mut dict,
                kSecAttrService.to_void(),
                svc_str.as_CFTypeRef() as *const c_void,
            );
            add_pair(
                &mut dict,
                kSecAttrAccount.to_void(),
                acct_str.as_CFTypeRef() as *const c_void,
            );
            add_pair(
                &mut dict,
                kSecValueData.to_void(),
                data.as_CFTypeRef() as *const c_void,
            );
            add_pair(
                &mut dict,
                kSecAttrAccessControl.to_void(),
                access.as_CFTypeRef() as *const c_void,
            );
            add_pair(
                &mut dict,
                kSecUseDataProtectionKeychain.to_void(),
                CFBoolean::true_value().to_void(),
            );
            add_pair(
                &mut dict,
                kSecAttrSynchronizable.to_void(),
                CFBoolean::false_value().to_void(),
            );
        }

        let status = unsafe {
            SecItemAdd(
                dict.to_immutable().as_concrete_TypeRef(),
                ptr::null_mut(),
            )
        };
        if status != 0 {
            return Err(format!("SecItemAdd failed (OSStatus {status})"));
        }
        Ok(())
    }

    pub fn load(key_id: &str) -> Result<String, String> {
        let service = service_for(key_id);
        let mut query = build_query_dict(&service);
        // kSecMatchLimit takes a CFNumber for "n results" or one of
        // the kSecMatchLimit{One,All} CFString constants. The "one"
        // constant isn't re-exported by security-framework-sys 2.x,
        // so we build the equivalent CFNumber(1) ourselves.
        let limit_one = CFNumber::from(1i64);
        unsafe {
            add_pair(
                &mut query,
                kSecMatchLimit.to_void(),
                limit_one.as_CFTypeRef() as *const c_void,
            );
            add_pair(
                &mut query,
                kSecReturnData.to_void(),
                CFBoolean::true_value().to_void(),
            );
        }

        let mut result: CFTypeRef = ptr::null();
        let status = unsafe {
            SecItemCopyMatching(
                query.to_immutable().as_concrete_TypeRef(),
                &mut result,
            )
        };
        if status != 0 {
            if status == errSecItemNotFound {
                return Err("no wrap key found in keychain".to_string());
            }
            return Err(format!("SecItemCopyMatching failed (OSStatus {status})"));
        }
        if result.is_null() {
            return Err("keychain returned empty payload".to_string());
        }

        // We own the returned ref (create rule from SecItemCopyMatching).
        let cf_data: CFData = unsafe { CFData::wrap_under_create_rule(result as _) };
        let bytes = cf_data.bytes().to_vec();
        String::from_utf8(bytes).map_err(|e| format!("invalid utf8 in keychain: {e}"))
    }

    pub fn clear(key_id: &str) -> Result<(), String> {
        let service = service_for(key_id);
        let query = build_query_dict(&service);
        let status = unsafe {
            SecItemDelete(query.to_immutable().as_concrete_TypeRef())
        };
        if status != 0 && status != errSecItemNotFound {
            return Err(format!("SecItemDelete failed (OSStatus {status})"));
        }
        Ok(())
    }
}

// ─── Windows implementation ──────────────────────────────────────────

#[cfg(target_os = "windows")]
mod platform {
    use super::service_for;
    use windows::core::HSTRING;
    use windows::Security::Credentials::UI::{
        UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
    };
    use windows::Security::Credentials::{PasswordCredential, PasswordVault};

    const USERNAME: &str = "default";

    pub fn available() -> bool {
        match UserConsentVerifier::CheckAvailabilityAsync().and_then(|op| op.get()) {
            Ok(UserConsentVerifierAvailability::Available) => true,
            _ => false,
        }
    }

    fn vault() -> Result<PasswordVault, String> {
        PasswordVault::new().map_err(|e| format!("PasswordVault::new: {e}"))
    }

    pub fn save(key_id: &str, key_b64: &str) -> Result<(), String> {
        let v = vault()?;
        let resource = HSTRING::from(service_for(key_id));
        let user = HSTRING::from(USERNAME);
        let secret = HSTRING::from(key_b64);

        // Replace any existing credential first.
        let _ = clear(key_id);
        let cred = PasswordCredential::CreatePasswordCredential(&resource, &user, &secret)
            .map_err(|e| format!("create cred: {e}"))?;
        v.Add(&cred).map_err(|e| format!("vault Add: {e}"))?;
        Ok(())
    }

    pub fn load(key_id: &str) -> Result<String, String> {
        // Prompt for Windows Hello before yielding the credential.
        // PasswordVault itself is keyed to the Windows account; the
        // explicit user-presence check is what gives us "biometric
        // unlock" semantics on top.
        let prompt = HSTRING::from("Unlock Meo");
        match UserConsentVerifier::RequestVerificationAsync(&prompt).and_then(|op| op.get()) {
            Ok(UserConsentVerificationResult::Verified) => {}
            Ok(other) => return Err(format!("Windows Hello declined: {other:?}")),
            Err(e) => return Err(format!("Windows Hello unavailable: {e}")),
        }

        let v = vault()?;
        let resource = HSTRING::from(service_for(key_id));
        let user = HSTRING::from(USERNAME);
        let cred = v
            .Retrieve(&resource, &user)
            .map_err(|e| format!("vault Retrieve: {e}"))?;
        cred.RetrievePassword()
            .map_err(|e| format!("RetrievePassword: {e}"))?;
        let pw = cred.Password().map_err(|e| format!("Password(): {e}"))?;
        Ok(pw.to_string_lossy())
    }

    pub fn clear(key_id: &str) -> Result<(), String> {
        let v = match vault() {
            Ok(v) => v,
            Err(_) => return Ok(()),
        };
        let resource = HSTRING::from(service_for(key_id));
        let user = HSTRING::from(USERNAME);
        if let Ok(cred) = v.Retrieve(&resource, &user) {
            let _ = v.Remove(&cred);
        }
        Ok(())
    }
}

// ─── Linux / other-OS stub ───────────────────────────────────────────
//
// Linux gets a stub that honestly reports "no biometric" so the UI
// falls through to passphrase. Wiring libsecret properly requires
// dbus dev headers at build time and there's no biometric primitive
// on most Linux desktops anyway. Tracked as a follow-on: a future
// agent could plumb in `secret-service` for at-rest protection
// without biometric, but the security model would be no different
// than what the JWT cookie already gives - punt for v1.0.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    pub fn available() -> bool {
        false
    }

    pub fn save(_key_id: &str, _key_b64: &str) -> Result<(), String> {
        Err("biometric not available on this OS".to_string())
    }

    pub fn load(_key_id: &str) -> Result<String, String> {
        Err("biometric not available on this OS".to_string())
    }

    pub fn clear(_key_id: &str) -> Result<(), String> {
        // Silent no-op on sign-out so the JS path stays consistent.
        Ok(())
    }
}
