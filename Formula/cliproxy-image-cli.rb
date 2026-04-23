class CliproxyImageCli < Formula
  desc "Codex-native CLI for generating and editing images through the local Codex OpenAI configuration."
  homepage "https://github.com/noooob-coder/cliproxy-image-cli"
  url "https://registry.npmjs.org/cliproxy-image-cli/-/cliproxy-image-cli-0.2.8.tgz"
  sha256 "9aa6b24e7a677aaca4027a651c2115ed44e0b2efed76b8947550f8cfe0fd28a1"
  license :cannot_represent
  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match "Generate or edit images", shell_output("#{bin}/cliproxy-image-cli --help")
  end
end
