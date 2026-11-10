<?php

declare(strict_types=1);

namespace App\Module\Merchant\Service;

use App\Module\Category\Domain\Entity\Category;
use App\Module\Category\Exception\CategoryNotFoundException;
use App\Module\Category\Repository\CategoryRepository;
use App\Module\Merchant\Domain\Entity\Merchant;
use App\Module\Merchant\Exception\MerchantInUseException;
use App\Module\Merchant\Exception\MerchantNotFoundException;
use App\Module\Merchant\Repository\MerchantRepository;
use App\Module\Security\Contract\Service\ICurrentUserAccessor;
use App\Module\Security\Domain\Entity\User;
use App\Shared\Upload\LocalUploadStorage;
use Symfony\Component\HttpFoundation\File\UploadedFile;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Uid\Uuid;

final class MerchantManager
{
    public function __construct(
        private readonly MerchantRepository $merchants,
        private readonly CategoryRepository $categories,
        private readonly LocalUploadStorage $uploads,
        private readonly ICurrentUserAccessor $users,
    ) {
    }

    /**
     * @return list<array<string, mixed>>
     */
    public function list(bool $includeArchived = false): array
    {
        return array_map(
            $this->serialize(...),
            $this->merchants->listForOwner($this->users->requireUser(), $includeArchived),
        );
    }

    /**
     * @param array{name: string, color: string, icon: string, position?: int, categoryIds?: list<string>} $data
     *
     * @return array<string, mixed>
     */
    public function create(array $data): array
    {
        $owner = $this->users->requireUser();
        $this->assertColor($data['color']);
        $merchant = new Merchant(
            $owner,
            $data['name'],
            $data['color'],
            $data['icon'],
            $data['position'] ?? 0,
        );
        $this->assertHasVisual($merchant);
        $this->merchants->save($merchant);
        if (\array_key_exists('categoryIds', $data)) {
            $this->syncCategories($merchant, $owner, $data['categoryIds']);
            $this->merchants->save($merchant);
        }

        return $this->serialize($merchant);
    }

    /**
     * @param array{name?: string, color?: string, icon?: string, position?: int, categoryIds?: list<string>} $data
     *
     * @return array<string, mixed>
     */
    public function update(string $id, array $data): array
    {
        $owner = $this->users->requireUser();
        $merchant = $this->requireOwned($id);
        if (isset($data['name'])) {
            $merchant->setName($data['name']);
        }
        if (isset($data['color'])) {
            $this->assertColor($data['color']);
            $merchant->setColor($data['color']);
        }
        if (isset($data['icon'])) {
            $this->replaceIcon($merchant, $data['icon']);
        }
        if (isset($data['position'])) {
            $merchant->setPosition($data['position']);
        }
        if (\array_key_exists('categoryIds', $data)) {
            $this->syncCategories($merchant, $owner, $data['categoryIds'] ?? []);
        }
        $this->assertHasVisual($merchant);
        $this->merchants->save($merchant);

        return $this->serialize($merchant);
    }

    /**
     * @return array<string, mixed>
     */
    public function archive(string $id): array
    {
        $merchant = $this->requireOwned($id);
        if ($this->merchants->countTransactions($merchant) > 0) {
            throw new MerchantInUseException();
        }
        foreach ($merchant->getCategories()->toArray() as $category) {
            $category->removeMerchant($merchant);
            $this->categories->save($category);
        }
        if ($merchant->hasImage()) {
            $this->uploads->delete($merchant->getImagePath());
            $merchant->setImagePath(null);
        }
        $merchant->archive();
        $this->merchants->save($merchant);

        return $this->serialize($merchant);
    }

    public function requireOwnedEntity(string $id): Merchant
    {
        return $this->requireOwned($id);
    }

    /**
     * @return array<string, mixed>
     */
    public function uploadImage(string $id, UploadedFile $file): array
    {
        $merchant = $this->requireOwned($id);
        $this->uploads->assertImageMime($file);
        $ownerId = (string) $merchant->getOwner()->getId();
        $relative = $this->uploads->store($file, 'merchants/'.$ownerId);
        if ($merchant->hasImage()) {
            $this->uploads->delete($merchant->getImagePath());
        }
        $merchant->setImagePath($relative);
        $merchant->setIcon(null);
        $this->assertHasVisual($merchant);
        $this->merchants->save($merchant);

        return $this->serialize($merchant);
    }

    public function streamImage(string $id): Response
    {
        $merchant = $this->requireOwned($id);
        if (!$merchant->hasImage()) {
            throw new MerchantNotFoundException();
        }
        $relative = (string) $merchant->getImagePath();
        try {
            $response = $this->uploads->createFileResponse($relative);
            // Cache navigateur privé (JWT) — complément du cache mémoire front.
            $response->headers->set('Cache-Control', 'private, max-age=86400');

            return $response;
        } catch (\InvalidArgumentException) {
            throw new MerchantNotFoundException();
        }
    }

    /**
     * @return array<string, mixed>
     */
    public function clearImage(string $id): array
    {
        $merchant = $this->requireOwned($id);
        if ($merchant->hasImage()) {
            $this->uploads->delete($merchant->getImagePath());
            $merchant->setImagePath(null);
        }
        $this->assertHasVisual($merchant);
        $this->merchants->save($merchant);

        return $this->serialize($merchant);
    }

    /**
     * @param list<string> $categoryIds
     */
    private function syncCategories(Merchant $merchant, User $owner, array $categoryIds): void
    {
        $wanted = [];
        foreach (array_values(array_unique($categoryIds)) as $categoryId) {
            $wanted[$categoryId] = $this->requireCategory($owner, $categoryId);
        }

        foreach ($merchant->getCategories()->toArray() as $existing) {
            $id = (string) $existing->getId();
            if (!isset($wanted[$id])) {
                $existing->removeMerchant($merchant);
                $this->categories->save($existing);
            }
        }

        foreach ($wanted as $category) {
            if (!$category->getMerchants()->contains($merchant)) {
                $category->addMerchant($merchant);
                $this->categories->save($category);
            }
        }
    }

    private function requireCategory(User $owner, string $id): Category
    {
        $category = $this->categories->findOwned(Uuid::fromString($id), $owner);
        if (null === $category || $category->isArchived()) {
            throw new CategoryNotFoundException();
        }

        return $category;
    }

    private function requireOwned(string $id): Merchant
    {
        $merchant = $this->merchants->findOwned(Uuid::fromString($id), $this->users->requireUser());
        if (null === $merchant || $merchant->isArchived()) {
            throw new MerchantNotFoundException();
        }

        return $merchant;
    }

    private function replaceIcon(Merchant $merchant, string $icon): void
    {
        if ($merchant->hasImage()) {
            $this->uploads->delete($merchant->getImagePath());
            $merchant->setImagePath(null);
        }
        $merchant->setIcon($icon);
    }

    private function assertHasVisual(Merchant $merchant): void
    {
        $hasIcon = null !== $merchant->getIcon() && '' !== $merchant->getIcon();
        if (!$hasIcon && !$merchant->hasImage()) {
            throw new \InvalidArgumentException('Une icône ou une image est requise pour l’enseigne.');
        }
    }

    private function assertColor(string $color): void
    {
        $trimmed = trim($color);
        if (0 === strcasecmp($trimmed, 'transparent')) {
            return;
        }
        if (!preg_match('/^#[0-9A-Fa-f]{6}$/', $trimmed)) {
            throw new \InvalidArgumentException('La couleur doit être #RRGGBB ou transparent.');
        }
    }

    /**
     * @return array<string, mixed>
     */
    public function serialize(Merchant $merchant): array
    {
        $id = (string) $merchant->getId();
        $hasImage = $merchant->hasImage();
        $categoryIds = [];
        foreach ($merchant->getCategories() as $category) {
            if (!$category->isArchived()) {
                $categoryIds[] = (string) $category->getId();
            }
        }

        return [
            'id'          => $id,
            'name'        => $merchant->getName(),
            'color'       => $merchant->getColor(),
            'icon'        => $merchant->getIcon(),
            'hasImage'    => $hasImage,
            'imageUrl'    => $hasImage ? '/api/merchants/'.$id.'/image' : null,
            'position'    => $merchant->getPosition(),
            'categoryIds' => $categoryIds,
            'archivedAt'  => $merchant->getArchivedAt()?->format(\DateTimeInterface::ATOM),
            'createdAt'   => $merchant->getCreatedAt()->format(\DateTimeInterface::ATOM),
        ];
    }
}
