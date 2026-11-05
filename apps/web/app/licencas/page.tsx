import type { Metadata } from "next";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Licenças · Cebola" };

export default function LicensesPage() {
  return (
    <main className={styles.page}>
      <a href="/download/index.html">← Voltar ao download</a>
      <h1>Licenças e código-fonte</h1>
      <p>O aplicativo Cebola utiliza o libVLC 3.6.2, do projeto VideoLAN.</p>
      <p>
        O libVLC é disponibilizado sob LGPL-2.1+. A compilação utilizada inclui os módulos
        libdvdcss, libdvdnav e libdvdread sob GPL-2.0+; por isso, o APK distribuído é tratado
        como GPL-2.0+.
      </p>
      <h2>Código-fonte correspondente</h2>
      <ul>
        <li>Código-fonte, instruções de compilação e licenças acompanham o repositório OpenCebola desta instalação.</li>
        <li><a href="https://code.videolan.org/videolan/vlc">VLC/libVLC</a></li>
        <li><a href="https://code.videolan.org/videolan/libdvdcss">libdvdcss</a></li>
        <li><a href="https://code.videolan.org/videolan/libdvdnav">libdvdnav</a></li>
        <li><a href="https://code.videolan.org/videolan/libdvdread">libdvdread</a></li>
      </ul>
      <h2>Textos das licenças</h2>
      <ul>
        <li><a href="https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html">LGPL versão 2.1</a></li>
        <li><a href="https://www.gnu.org/licenses/old-licenses/gpl-2.0.html">GPL versão 2</a></li>
      </ul>
      <p>O Cebola não é afiliado ao projeto VideoLAN e não utiliza suas marcas ou logotipo.</p>
    </main>
  );
}
