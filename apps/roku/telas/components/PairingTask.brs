sub init()
  m.top.functionName = "runPairing"
end sub

sub runPairing()
  m.top.result = ""
  m.top.pairingCode = ""
  savedToken = loadSession()
  if savedToken <> "" then
    sessionResponse = apiGet("/v1/auth/session", savedToken)
    if sessionResponse.status = 200 then
      m.top.result = "paired"
      return
    end if
    ' Só sessão recusada apaga o token; falha de rede ou servidor fora não desconecta a TV.
    if sessionResponse.status <> 401 and sessionResponse.status <> 403 then
      m.top.result = "error"
      return
    end if
    clearSession()
  end if

  codeResponse = apiPost("/v1/auth/device/code", "")
  if codeResponse.status <> 200 then
    m.top.result = "error"
    return
  end if

  ticket = ParseJson(codeResponse.body)
  if ticket = invalid or ticket.code = invalid or ticket.deviceId = invalid then
    m.top.result = "error"
    return
  end if
  m.top.pairingCode = ticket.code
  attempts = int(ticket.expiresInSeconds / 3)
  if attempts < 1 then attempts = 1

  for attempt = 1 to attempts
    ' Chave sem aspas num literal vira minúscula ("deviceid") e a API recusa com 400.
    payload = FormatJson({ "code": ticket.code, "deviceId": ticket.deviceId })
    claimResponse = apiPost("/v1/auth/device/claim", payload)
    if claimResponse.status = 200 then
      session = ParseJson(claimResponse.body)
      if session <> invalid and session.token <> invalid then
        saveSession(session.token)
        m.top.result = "paired"
        return
      end if
      m.top.result = "error"
      return
    else if claimResponse.status > 0 and claimResponse.status <> 202 and claimResponse.status <> 503 then
      m.top.result = "expired"
      return
    end if
    ' status <= 0 é falha de rede (código do curl): tenta de novo na próxima volta.
    sleep(3000)
  end for
  m.top.result = "expired"
end sub

function apiGet(path as String, token as String) as Object
  return apiRequest("GET", path, "", token)
end function

function apiPost(path as String, body as String) as Object
  return apiRequest("POST", path, body, "")
end function

' roUrlTransfer não tem GetResponseCode(): no modo síncrono o GET devolve só o corpo e o POST
' só o status. O modo assíncrono entrega os dois no roUrlEvent (status <= 0 = falha do curl).
function apiRequest(method as String, path as String, body as String, token as String) as Object
  port = CreateObject("roMessagePort")
  transfer = CreateObject("roUrlTransfer")
  transfer.SetMessagePort(port)
  transfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
  transfer.InitClientCertificates()
  transfer.RetainBodyOnError(true)
  transfer.SetUrl(openCebolaApiUrl() + path)
  transfer.AddHeader("Accept", "application/json")
  if token <> "" then transfer.AddHeader("Authorization", "Bearer " + token)

  if method = "POST" then
    ' Sem Content-Type a Roku manda formulário e a API responde 415; JSON vazio é aceito.
    transfer.AddHeader("Content-Type", "application/json")
    if body = "" then body = "{}"
    started = transfer.AsyncPostFromString(body)
  else
    started = transfer.AsyncGetToString()
  end if
  if not started then return { status: 0, body: "" }

  event = wait(15000, port)
  if type(event) = "roUrlEvent" then
    return { status: event.GetResponseCode(), body: event.GetString() }
  end if
  transfer.AsyncCancel()
  return { status: 0, body: "" }
end function

sub saveSession(token as String)
  section = CreateObject("roRegistrySection", "cebola")
  section.Write("session", token)
  section.Flush()
end sub

function loadSession() as String
  section = CreateObject("roRegistrySection", "cebola")
  if section.Exists("session") then return section.Read("session")
  return ""
end function

sub clearSession()
  section = CreateObject("roRegistrySection", "cebola")
  section.Delete("session")
  section.Flush()
end sub
