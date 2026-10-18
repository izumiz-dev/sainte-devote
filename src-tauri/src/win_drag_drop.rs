use std::{
    cell::UnsafeCell,
    collections::HashMap,
    ffi::{c_void, OsString},
    os::windows::ffi::OsStringExt,
    path::PathBuf,
    ptr,
    sync::{Mutex, OnceLock},
};

use tauri::{Manager, Runtime, WebviewWindow};
use windows::{
    core::{implement, BOOL},
    Win32::{
        Foundation::{DRAGDROP_E_INVALIDHWND, HWND, LPARAM, POINT, POINTL},
        Graphics::Gdi::ScreenToClient,
        System::{
            Com::{IDataObject, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL},
            Ole::{
                IDropTarget, IDropTarget_Impl, RegisterDragDrop, RevokeDragDrop, CF_HDROP,
                DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_MOVE, DROPEFFECT_NONE,
            },
            SystemServices::MODIFIERKEYS_FLAGS,
        },
        UI::{
            Shell::{DragFinish, DragQueryFileW, HDROP},
            WindowsAndMessaging::EnumChildWindows,
        },
    },
};

fn installed_hwnds() -> &'static Mutex<HashMap<String, Vec<isize>>> {
    static INSTALLED: OnceLock<Mutex<HashMap<String, Vec<isize>>>> = OnceLock::new();
    INSTALLED.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Replace wry's file-only `IDropTarget` on WebView2 child HWNDs with one that
/// forwards both file drops (`CF_HDROP`) and in-app tab drags (empty `paths`) to
/// [`crate::session::handle_drag_drop`], matching WKWebView's behavior on macOS.
pub fn install<R: Runtime>(window: &WebviewWindow<R>) {
    let Ok(root_hwnd) = window.hwnd() else {
        return;
    };
    let label = window.label().to_string();
    let app = window.app_handle().clone();

    let mut children = Vec::new();
    {
        let mut collect = |hwnd: HWND| {
            children.push(hwnd);
            true
        };
        let mut trait_obj: &mut dyn FnMut(HWND) -> bool = &mut collect;
        let closure_ptr: *mut c_void = (&mut trait_obj as *mut &mut dyn FnMut(HWND) -> bool).cast();
        unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let closure = unsafe { &mut *(lparam.0 as *mut &mut dyn FnMut(HWND) -> bool) };
            closure(hwnd).into()
        }
        let _ =
            unsafe { EnumChildWindows(Some(root_hwnd), Some(enum_proc), LPARAM(closure_ptr as _)) };
    }

    let mut map = installed_hwnds()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let recorded = map.entry(label.clone()).or_default();

    for child_hwnd in children {
        let key = child_hwnd.0 as isize;
        if recorded.contains(&key) {
            continue;
        }
        let app_clone = app.clone();
        let label_clone = label.clone();
        let handler: Box<dyn Fn(tauri::DragDropEvent)> = Box::new(move |event| {
            if let Some(webview) = app_clone.get_webview_window(&label_clone) {
                crate::session::handle_drag_drop(&webview, &event);
            }
        });
        let target: IDropTarget = WinDropTarget::new(child_hwnd, handler).into();
        if unsafe { RevokeDragDrop(child_hwnd) } != Err(DRAGDROP_E_INVALIDHWND.into())
            && unsafe { RegisterDragDrop(child_hwnd, &target) }.is_ok()
        {
            recorded.push(key);
        }
    }
}

pub fn cleanup(label: &str) {
    if let Ok(mut map) = installed_hwnds().lock() {
        map.remove(label);
    }
}

#[implement(IDropTarget)]
struct WinDropTarget {
    hwnd: HWND,
    handler: Box<dyn Fn(tauri::DragDropEvent)>,
    cursor_effect: UnsafeCell<DROPEFFECT>,
}

impl WinDropTarget {
    fn new(hwnd: HWND, handler: Box<dyn Fn(tauri::DragDropEvent)>) -> Self {
        Self {
            hwnd,
            handler,
            cursor_effect: DROPEFFECT_NONE.into(),
        }
    }

    unsafe fn iterate_filenames<F>(
        data_obj: windows_core::Ref<'_, IDataObject>,
        mut callback: F,
    ) -> Option<HDROP>
    where
        F: FnMut(PathBuf),
    {
        let drop_format = FORMATETC {
            cfFormat: CF_HDROP.0,
            ptd: ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
        };

        let Ok(medium) = data_obj.as_ref()?.GetData(&drop_format) else {
            return None;
        };

        let hdrop = HDROP(unsafe { medium.u.hGlobal.0 } as _);
        let item_count = unsafe { DragQueryFileW(hdrop, 0xFFFFFFFF, None) };

        for i in 0..item_count {
            let character_count = unsafe { DragQueryFileW(hdrop, i, None) } as usize;
            let str_len = character_count + 1;
            let mut path_buf = vec![0; str_len];
            unsafe { DragQueryFileW(hdrop, i, Some(&mut path_buf)) };
            callback(OsString::from_wide(&path_buf[0..character_count]).into());
        }

        Some(hdrop)
    }
}

#[allow(non_snake_case)]
impl IDropTarget_Impl for WinDropTarget_Impl {
    fn DragEnter(
        &self,
        pDataObj: windows_core::Ref<'_, IDataObject>,
        _grfKeyState: MODIFIERKEYS_FLAGS,
        pt: &POINTL,
        pdwEffect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        let mut pt = POINT { x: pt.x, y: pt.y };
        let _ = unsafe { ScreenToClient(self.hwnd, &mut pt) };

        let mut paths = Vec::new();
        let hdrop = unsafe { WinDropTarget::iterate_filenames(pDataObj, |path| paths.push(path)) };

        let cursor_effect = if hdrop.is_some() {
            DROPEFFECT_COPY
        } else {
            let allowed = unsafe { *pdwEffect };
            if (allowed & DROPEFFECT_MOVE) != DROPEFFECT_NONE {
                DROPEFFECT_MOVE
            } else if (allowed & DROPEFFECT_COPY) != DROPEFFECT_NONE {
                DROPEFFECT_COPY
            } else {
                DROPEFFECT_MOVE
            }
        };

        (self.handler)(tauri::DragDropEvent::Enter {
            paths,
            position: tauri::PhysicalPosition::new(pt.x as f64, pt.y as f64),
        });

        unsafe {
            *pdwEffect = cursor_effect;
            *self.cursor_effect.get() = cursor_effect;
        }

        Ok(())
    }

    fn DragOver(
        &self,
        _grfKeyState: MODIFIERKEYS_FLAGS,
        pt: &POINTL,
        pdwEffect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        let mut pt = POINT { x: pt.x, y: pt.y };
        let _ = unsafe { ScreenToClient(self.hwnd, &mut pt) };

        (self.handler)(tauri::DragDropEvent::Over {
            position: tauri::PhysicalPosition::new(pt.x as f64, pt.y as f64),
        });

        unsafe {
            *pdwEffect = *self.cursor_effect.get();
        }
        Ok(())
    }

    fn DragLeave(&self) -> windows::core::Result<()> {
        (self.handler)(tauri::DragDropEvent::Leave);
        Ok(())
    }

    fn Drop(
        &self,
        pDataObj: windows_core::Ref<'_, IDataObject>,
        _grfKeyState: MODIFIERKEYS_FLAGS,
        pt: &POINTL,
        pdwEffect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        let mut pt = POINT { x: pt.x, y: pt.y };
        let _ = unsafe { ScreenToClient(self.hwnd, &mut pt) };

        let mut paths = Vec::new();
        let hdrop = unsafe { WinDropTarget::iterate_filenames(pDataObj, |path| paths.push(path)) };

        (self.handler)(tauri::DragDropEvent::Drop {
            paths,
            position: tauri::PhysicalPosition::new(pt.x as f64, pt.y as f64),
        });

        if let Some(hdrop) = hdrop {
            unsafe { DragFinish(hdrop) };
        }

        unsafe {
            *pdwEffect = *self.cursor_effect.get();
        }
        Ok(())
    }
}
