import Foundation
import WebKit

/// Mudança de documento descarta o JS antigo, que pode não conseguir encerrar a sessão.
func replacesPlaybackDocument(_ action: WKNavigationAction, currentURL: URL?) -> Bool {
    guard action.targetFrame?.isMainFrame == true else { return false }
    if action.navigationType == .reload { return true }
    if let currentURL, let destination = action.request.url,
       var current = URLComponents(url: currentURL, resolvingAgainstBaseURL: false),
       var next = URLComponents(url: destination, resolvingAgainstBaseURL: false) {
        let fragmentChanged = current.fragment != next.fragment
        current.fragment = nil
        next.fragment = nil
        if fragmentChanged && current == next { return false }
    }
    return true
}
