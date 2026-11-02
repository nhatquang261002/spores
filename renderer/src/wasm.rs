//! C ABI for the wasm32 build, used by `viz` and the JS cross-check. The caller
//! allocates every buffer through `alloc`, so there is no shared state.

use crate::{image_hash, render, Spore, N};

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr` and `len` must come from a matching `alloc` call.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len));
}

/// Output size in bytes for `render`.
#[no_mangle]
pub extern "C" fn image_len() -> usize {
    N * N * 3
}

/// Parse `Spore::from_bytes` input and write `image_len()` bytes to `out`. 0 = ok.
///
/// # Safety
/// `input` must point to `len` readable bytes and `out` to `image_len()` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn render_into(input: *const u8, len: usize, out: *mut u8) -> i32 {
    let Some(sp) = Spore::from_bytes(std::slice::from_raw_parts(input, len)) else {
        return 1;
    };
    std::ptr::copy_nonoverlapping(render(&sp).as_ptr(), out, N * N * 3);
    0
}

/// Write the 32-byte image hash of an `image_len()`-byte buffer to `out`.
///
/// # Safety
/// `rgb` must point to `image_len()` readable bytes and `out` to 32 writable bytes.
#[no_mangle]
pub unsafe extern "C" fn hash_image(rgb: *const u8, out: *mut u8) {
    let h = image_hash(std::slice::from_raw_parts(rgb, N * N * 3));
    std::ptr::copy_nonoverlapping(h.as_ptr(), out, 32);
}
