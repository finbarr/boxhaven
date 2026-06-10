# frozen_string_literal: true

# BoxHaven binary formula template for the finbarr/homebrew-tap tap.
#
# This file is a template: the release orchestrator replaces the
# placeholders below from a tagged release and its SHA256SUMS file,
# then commits the result to the tap as Formula/boxhaven.rb.
#
#   __VERSION__              release version without the leading "v" (e.g. 0.3.0)
#   __SHA256_DARWIN_AMD64__  sha256 of bh_v__VERSION___darwin_amd64.tar.gz
#   __SHA256_DARWIN_ARM64__  sha256 of bh_v__VERSION___darwin_arm64.tar.gz
#   __SHA256_LINUX_AMD64__   sha256 of bh_v__VERSION___linux_amd64.tar.gz
#   __SHA256_LINUX_ARM64__   sha256 of bh_v__VERSION___linux_arm64.tar.gz
#
# See packaging/homebrew/README.md for the fill-in workflow.
class Boxhaven < Formula
  desc "Named remote Linux boxes for AI coding agents"
  homepage "https://github.com/finbarr/boxhaven"
  version "__VERSION__"
  license "AGPL-3.0-only"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/finbarr/boxhaven/releases/download/v#{version}/bh_v#{version}_darwin_arm64.tar.gz"
      sha256 "__SHA256_DARWIN_ARM64__"
    else
      url "https://github.com/finbarr/boxhaven/releases/download/v#{version}/bh_v#{version}_darwin_amd64.tar.gz"
      sha256 "__SHA256_DARWIN_AMD64__"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/finbarr/boxhaven/releases/download/v#{version}/bh_v#{version}_linux_arm64.tar.gz"
      sha256 "__SHA256_LINUX_ARM64__"
    else
      url "https://github.com/finbarr/boxhaven/releases/download/v#{version}/bh_v#{version}_linux_amd64.tar.gz"
      sha256 "__SHA256_LINUX_AMD64__"
    end
  end

  def install
    bin.install "bh"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/bh version")
  end
end
