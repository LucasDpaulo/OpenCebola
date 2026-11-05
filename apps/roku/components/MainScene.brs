' Casca definitiva da Roku: só carrega a biblioteca de telas do servidor. Sem chamadas à API
' (pareamento, sessão e perfis vivem na biblioteca). Escolhe sozinha entre a versão "atual" e a
' "anterior" das telas para se recuperar de uma versão que derruba o app.

sub init()
  m.status = m.top.findNode("status")
  m.retry = m.top.findNode("telasRetry")
  m.carregador = m.top.findNode("carregador")
  m.lib = invalid
  m.limite = m.top.findNode("limite")
  m.limite.observeField("fire", "onLimite")
  m.autoRetry = m.top.findNode("autoRetry")
  m.timerSaudavel = m.top.findNode("saudavel")
  m.tentativas = 0
  m.telas = invalid
  m.retry.observeField("buttonSelected", "onRetry")
  m.autoRetry.observeField("fire", "onRetry")
  m.timerSaudavel.observeField("fire", "onSaudavel")
  carregar(escolherVersao())
end sub

' ---- Registry: qual versão foi tentada e se ficou saudável ----

function lerRegistro(chave as String) as String
  section = CreateObject("roRegistrySection", "cebola")
  if section.Exists(chave) then return section.Read(chave)
  return ""
end function

sub gravarRegistro(chave as String, valor as String)
  section = CreateObject("roRegistrySection", "cebola")
  section.Write(chave, valor)
  section.Flush()
end sub

' Última tentativa saudável (ou primeira abertura) = atual; senão alterna atual <-> anterior.
function escolherVersao() as String
  ultima = lerRegistro("telasTentativa")
  if ultima = "" or lerRegistro("telasSaudavel") = "1" then return "atual"
  if ultima = "atual" then return "anterior"
  return "atual"
end function

' ---- URLs ----

function urlBase() as String
  base = CreateObject("roAppInfo").GetValue("cebola_telas_url")
  if base = "" then base = "https://instance.example.invalid/downloads/cebola-roku-telas.zip"
  return base
end function

' .../cebola-roku-telas.zip -> .../cebola-roku-telas-anterior.zip
function urlAnterior(base as String) as String
  return CreateObject("roRegex", "\.zip$", "").Replace(base, "-anterior.zip")
end function

sub carregar(qual as String)
  m.qual = qual
  gravarRegistro("telasTentativa", qual)
  gravarRegistro("telasSaudavel", "0")
  m.status.text = "Carregando o Cebola…"
  m.retry.visible = false
  m.autoRetry.control = "stop"
  m.timerSaudavel.control = "stop"
  if m.telas <> invalid then
    m.top.removeChild(m.telas)
    m.telas = invalid
    m.carregador.visible = true
  end if
  url = urlBase()
  if qual = "anterior" then url = urlAnterior(url)
  m.tentativas = m.tentativas + 1
  ' Nó novo a cada tentativa: trocar o uri de um ComponentLibrary já usado pode não baixar de novo.
  if m.lib <> invalid then
    m.lib.unobserveField("loadStatus")
    m.top.removeChild(m.lib)
  end if
  m.lib = CreateObject("roSGNode", "ComponentLibrary")
  m.lib.id = "CebolaTelas"
  m.lib.observeField("loadStatus", "onLibStatus")
  m.top.appendChild(m.lib)
  m.limite.control = "stop"
  m.limite.control = "start"
  ' Sem query string: na Roku real (01/11) o ComponentLibrary falha com "?v=" na URL. Cópia velha
  ' é evitada pelo Cache-Control: no-cache do Caddy.
  m.lib.uri = url
end sub

sub onLimite()
  if m.lib <> invalid and m.lib.loadStatus <> "ready" then falhou()
end sub

sub onLibStatus()
  estado = m.lib.loadStatus
  if estado = "ready" or estado = "failed" then m.limite.control = "stop"
  if estado = "ready" then
    ' O prefixo é o id do ComponentLibrary (CebolaTelas); verificar na TV.
    m.telas = CreateObject("roSGNode", "CebolaTelas:CebolaApp")
    if m.telas = invalid then
      falhou()
      return
    end if
    m.telas.observeField("pronto", "onPronto")
    ' Informa a versão da casca; a biblioteca compara com CASCA_MINIMA.
    m.telas.cascaVersion = CreateObject("roAppInfo").GetVersion()
    m.carregador.visible = false
    m.top.appendChild(m.telas)
    m.telas.setFocus(true)
  else if estado = "failed" then
    falhou()
  end if
end sub

sub falhou()
  if m.qual = "atual" then
    carregar("anterior")
    return
  end if
  m.status.text = "Não foi possível carregar o Cebola. Confira a internet."
  m.retry.visible = true
  m.retry.setFocus(true)
  m.autoRetry.control = "start"
end sub

sub onRetry()
  carregar("atual")
end sub

sub onPronto()
  if m.telas <> invalid and m.telas.pronto then m.timerSaudavel.control = "start"
end sub

sub onSaudavel()
  gravarRegistro("telasSaudavel", "1")
end sub
