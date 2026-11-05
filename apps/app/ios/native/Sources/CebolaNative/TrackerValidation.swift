import Darwin
import Foundation

private func publicAddress(_ text: String) -> Bool {
    var bytes = [UInt8](repeating: 0, count: 16)
    if inet_pton(AF_INET, text, &bytes) == 1 {
        return bytes[0] > 0 && bytes[0] < 224 && bytes[0] != 10 && bytes[0] != 127 &&
            !(bytes[0] == 169 && bytes[1] == 254) && !(bytes[0] == 172 && (16...31).contains(bytes[1])) &&
            !(bytes[0] == 192 && (bytes[1] == 168 || bytes[1] == 0)) &&
            !(bytes[0] == 100 && (64...127).contains(bytes[1])) &&
            !(bytes[0] == 198 && (bytes[1] == 18 || bytes[1] == 19 || (bytes[1] == 51 && bytes[2] == 100))) &&
            !(bytes[0] == 203 && bytes[1] == 0 && bytes[2] == 113)
    }
    return inet_pton(AF_INET6, text, &bytes) == 1 && (bytes[0] & 0xe0) == 0x20 &&
        !(bytes[0] == 0x20 && bytes[1] == 0x01 && bytes[2] == 0x0d && bytes[3] == 0xb8)
}

/// Aceita somente UDP e fixa o endereço após verificar todas as respostas DNS.
func safeTrackers(_ raw: [String]) async -> [String] {
    await Task.detached(priority: .utility) {
        var result: [String] = []
        for value in raw.prefix(32) {
            guard value.utf8.count <= 2048, var parts = URLComponents(string: value), parts.scheme == "udp",
                  parts.user == nil, parts.password == nil, parts.fragment == nil,
                  let host = parts.host, let port = parts.port, (1...65535).contains(port) else { continue }
            var hints = addrinfo()
            hints.ai_family = AF_UNSPEC
            hints.ai_socktype = SOCK_DGRAM
            var addresses: UnsafeMutablePointer<addrinfo>?
            guard getaddrinfo(host, String(port), &hints, &addresses) == 0, let first = addresses else { continue }
            var current: UnsafeMutablePointer<addrinfo>? = first
            var ips: [String] = []
            var valid = true
            while let item = current {
                var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                if getnameinfo(item.pointee.ai_addr, item.pointee.ai_addrlen, &buffer, socklen_t(buffer.count), nil, 0, NI_NUMERICHOST) != 0 {
                    valid = false; break
                }
                let ip = String(cString: buffer)
                if !publicAddress(ip) { valid = false; break }
                ips.append(ip)
                current = item.pointee.ai_next
            }
            freeaddrinfo(first)
            guard valid, let ip = ips.first else { continue }
            parts.host = ip.contains(":") ? "[\(ip)]" : ip
            if let url = parts.string, !result.contains(url) { result.append(url) }
        }
        return result
    }.value
}
