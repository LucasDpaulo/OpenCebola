#!/usr/bin/env python3
import sys
import xml.etree.ElementTree as ET
import zipfile


WIDGET_NS = "http://www.w3.org/ns/widgets"
TIZEN_NS = "http://tizen.org/ns/widgets"
XMLDSIG_NS = "http://www.w3.org/2000/09/xmldsig#"


class ValidationError(Exception):
    pass


def qualified(namespace, local_name):
    return f"{{{namespace}}}{local_name}"


def validate_config(config_xml, expected_id):
    try:
        root = ET.fromstring(config_xml)
    except ET.ParseError:
        raise ValidationError("config.xml malformado") from None

    if root.tag != qualified(WIDGET_NS, "widget"):
        raise ValidationError("elemento widget inválido")

    applications = root.findall(qualified(TIZEN_NS, "application"))
    if len(applications) != 1 or applications[0].get("id") != expected_id:
        raise ValidationError("application ID Tizen inesperado")

    profiles = root.findall(qualified(TIZEN_NS, "profile"))
    if not any(profile.get("name") == "tv" for profile in profiles):
        raise ValidationError("perfil TV ausente")


def validate_signature(signature_xml, filename):
    try:
        root = ET.fromstring(signature_xml)
    except ET.ParseError:
        raise ValidationError(f"{filename} malformado") from None

    if root.tag != qualified(XMLDSIG_NS, "Signature"):
        raise ValidationError(f"assinatura XML DSig inválida: {filename}")

    def invalid():
        raise ValidationError(f"assinatura XML DSig inválida: {filename}")

    def one_child(parent, local_name):
        children = parent.findall(qualified(XMLDSIG_NS, local_name))
        if len(children) != 1:
            invalid()
        return children[0]

    def require_algorithm(parent, local_name):
        element = one_child(parent, local_name)
        if not element.get("Algorithm", "").strip():
            invalid()

    def require_text(parent, local_name):
        element = one_child(parent, local_name)
        if not "".join(element.itertext()).strip():
            invalid()

    signed_info = one_child(root, "SignedInfo")
    require_algorithm(signed_info, "CanonicalizationMethod")
    require_algorithm(signed_info, "SignatureMethod")

    references = signed_info.findall(qualified(XMLDSIG_NS, "Reference"))
    if not references:
        invalid()
    for reference in references:
        require_algorithm(reference, "DigestMethod")
        require_text(reference, "DigestValue")

    require_text(root, "SignatureValue")
    key_info = one_child(root, "KeyInfo")
    if not list(key_info):
        invalid()


def main():
    wgt_path, expected_id = sys.argv[1:]
    with zipfile.ZipFile(wgt_path) as archive:
        config_xml = archive.read("config.xml")
        validate_config(config_xml, expected_id)
        root = ET.fromstring(config_xml)
        if any(service.get("id") == "CEBOLA0001.Streaming" for service in root.findall(qualified(TIZEN_NS, "service"))):
            for required in ("services/streaming-service.js", "services/streaming-core.cjs", "services/engine-core.cjs", "services/NUVIO-LICENSE", "www/streaming.js"):
                if required not in archive.namelist() or archive.getinfo(required).file_size == 0:
                    raise ValidationError("pacote declara motor local mas não contém os arquivos necessários")
        for filename in ("author-signature.xml", "signature1.xml"):
            validate_signature(archive.read(filename), filename)


if __name__ == "__main__":
    try:
        main()
    except ValidationError as error:
        print(f"ERRO: {error}", file=sys.stderr)
        raise SystemExit(2) from None
